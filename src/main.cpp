#include <iostream>
#include <chrono>
#include <thread>
#include <vector>
#include <cstring>
#include <csignal>
#include <atomic>
#include <deque>
#include <iomanip>
#include <mutex>
#include <optional>
#include <sstream>

#include "webSocketServer.hpp"
#include "nBodySim.hpp"
#include "scenarios.hpp"
#include "generated/frame_sample_generated.h"

namespace {
    constexpr bool DEFAULT_SIM_PAUSED = false;
    constexpr float DEFAULT_SIM_DT = 0.016667f;
    constexpr float GALAXY_COLLISION_DEFAULT_SIM_DT = 0.1666667f;
    constexpr auto PAUSED_POLL_INTERVAL = chrono::milliseconds(10);

    atomic<bool> g_running{true};
    void handleSignal(int) {
        g_running = false;
    }

    struct RuntimeControlState {
        bool paused = DEFAULT_SIM_PAUSED;
        float dt = DEFAULT_SIM_DT;
        float defaultDt = DEFAULT_SIM_DT;
    };

    float scenarioDefaultDt(const ScenarioSelection& selection) {
        return selection.kind == ScenarioKind::GalaxyCollision
            ? GALAXY_COLLISION_DEFAULT_SIM_DT
            : DEFAULT_SIM_DT;
    }

    struct ControlCommand {
        optional<bool> paused;
        optional<float> dt;
        bool reset = false;
    };

    bool parseControlBool(const string& value, bool& out) {
        if (value == "1" || value == "true") {
            out = true;
            return true;
        }
        if (value == "0" || value == "false") {
            out = false;
            return true;
        }
        return false;
    }

    bool parsePositiveFloat(const string& value, float& out) {
        try {
            size_t processed = 0;
            const float parsed = stof(value, &processed);
            if (processed != value.size() || !isfinite(parsed) || parsed <= 0.0f) return false;
            out = parsed;
            return true;
        } catch (...) {
            return false;
        }
    }

    optional<ControlCommand> parseControlMessage(const string& message) {
        if (message == "control:reset") {
            ControlCommand command;
            command.reset = true;
            return command;
        }

        constexpr string_view SET_PREFIX = "control:set?";
        if (message.rfind(SET_PREFIX.data(), 0) != 0) return nullopt;

        ControlCommand command;
        bool hasRecognizedField = false;
        const string query = message.substr(SET_PREFIX.size());
        size_t start = 0;

        while (start <= query.size()) {
            const size_t end = query.find('&', start);
            const string pair =
                query.substr(start, end == string::npos ? string::npos : end - start);

            if (!pair.empty()) {
                const size_t equals = pair.find('=');
                const string key = pair.substr(0, equals);
                const string value = equals == string::npos ? string() : pair.substr(equals + 1);

                if (key == "paused") {
                    bool parsed = false;
                    if (equals == string::npos || !parseControlBool(value, parsed)) return nullopt;
                    command.paused = parsed;
                    hasRecognizedField = true;
                } else if (key == "dt") {
                    float parsed = 0.0f;
                    if (equals == string::npos || !parsePositiveFloat(value, parsed)) return nullopt;
                    command.dt = parsed;
                    hasRecognizedField = true;
                }
            }

            if (end == string::npos) break;
            start = end + 1;
        }

        if (!hasRecognizedField) return nullopt;
        return command;
    }

    bool applyCommand(RuntimeControlState& state, const ControlCommand& command) {
        bool changed = false;

        if (command.reset) {
            if (state.paused != DEFAULT_SIM_PAUSED) {
                state.paused = DEFAULT_SIM_PAUSED;
                changed = true;
            }
            if (state.dt != state.defaultDt) {
                state.dt = state.defaultDt;
                changed = true;
            }
            return changed;
        }

        if (command.paused.has_value() && state.paused != *command.paused) {
            state.paused = *command.paused;
            changed = true;
        }

        if (command.dt.has_value() && state.dt != *command.dt) {
            state.dt = *command.dt;
            changed = true;
        }

        return changed;
    }

    string encodeControlStateMessage(const RuntimeControlState& state) {
        ostringstream stream;
        stream << setprecision(6)
               << "control:state?paused=" << (state.paused ? 1 : 0)
               << "&dt=" << state.dt
             << "&defaultDt=" << state.defaultDt;
        return stream.str();
    }

    struct ControlDrainResult {
        RuntimeControlState state;
        bool stateChanged = false;
        bool resetRequested = false;
        optional<ScenarioSelection> scenarioStartSelection;
    };

    class SimulationControlBridge {
        public:
        explicit SimulationControlBridge(RuntimeControlState initialState)
            : state_(initialState) {}

        bool enqueueMessage(const string& message) {
            optional<ControlCommand> command = parseControlMessage(message);
            if (!command.has_value()) return false;

            lock_guard<mutex> lock(mutex_);
            pendingCommands_.push_back(move(*command));
            return true;
        }

        void enqueueScenarioStart(const ScenarioSelection& selection) {
            lock_guard<mutex> lock(mutex_);
            pendingScenarioStarts_.push_back(selection);
        }

        RuntimeControlState snapshot() const {
            lock_guard<mutex> lock(mutex_);
            return state_;
        }

        void replaceState(const RuntimeControlState& nextState) {
            lock_guard<mutex> lock(mutex_);
            state_ = nextState;
        }

        ControlDrainResult drainPending() {
            lock_guard<mutex> lock(mutex_);
            ControlDrainResult result;

            while (!pendingCommands_.empty()) {
                result.stateChanged =
                    applyCommand(state_, pendingCommands_.front()) || result.stateChanged;
                result.resetRequested = pendingCommands_.front().reset || result.resetRequested;
                pendingCommands_.pop_front();
            }

            if (!pendingScenarioStarts_.empty()) {
                result.scenarioStartSelection = pendingScenarioStarts_.back();
                pendingScenarioStarts_.clear();
            }

            result.state = state_;
            return result;
        }

        private:
        mutable mutex mutex_;
        RuntimeControlState state_;
        deque<ControlCommand> pendingCommands_;
        deque<ScenarioSelection> pendingScenarioStarts_;
    };

    inline uint32_t toLittleEndian(uint32_t v) {
        #if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
        return ((v & 0x000000FFu) << 24) | ((v & 0x0000FF00u) << 8) |
            ((v & 0x00FF0000u) >> 8) | ((v & 0xFF000000u) >> 24);
        #else
        // little-endian host
        return v;
        #endif
    }

    void broadcastFrame(const ParticleSystem& system,
                        int frame,
                        flatbuffers::FlatBufferBuilder& builder,
                        FrameBroadcaster& broadcaster) {
        builder.Clear();

        float* interleaved = nullptr;
        const auto bodies = builder.CreateUninitializedVector<float>(system.size() * 6, &interleaved);

        size_t writeIdx = 0;
        for (const BodyBlock& blk : system.blocks)
            for (size_t lane = 0; lane < blk.count; ++lane) {
                interleaved[writeIdx++] = blk.posX[lane];
                interleaved[writeIdx++] = blk.posY[lane];
                interleaved[writeIdx++] = blk.posZ[lane];
                interleaved[writeIdx++] = blk.velX[lane];
                interleaved[writeIdx++] = blk.velY[lane];
                interleaved[writeIdx++] = blk.velZ[lane];
            }

        const auto sample = nbody::CreateFrameSample(
            builder,
            static_cast<uint32_t>(frame),
            static_cast<uint32_t>(system.size()),
            bodies);

        // Build a non-size-prefixed FlatBuffer so we can add our own 4-byte length prefix.
        nbody::FinishFrameSampleBuffer(builder, sample);

        const uint32_t payloadSize = static_cast<uint32_t>(builder.GetSize());
        const uint32_t lenLE = toLittleEndian(payloadSize);

        auto packet = make_shared<vector<uint8_t>>(sizeof(lenLE) + payloadSize);
        memcpy(packet->data(), &lenLE, sizeof(lenLE));
        memcpy(packet->data() + sizeof(lenLE), builder.GetBufferPointer(), payloadSize);
        broadcaster.broadcast(packet);
    }

    string scenarioTitleFromSelection(const ScenarioSelection& selection) {
        switch (selection.kind) {
            case ScenarioKind::Galaxy: return "Galaxy";
            case ScenarioKind::GalaxyCollision: return "Galaxy Collision";
            case ScenarioKind::StableOrbits: return "Stable Orbits";
            case ScenarioKind::AccretionDisk: return "Accretion Disk";
            default: return "Simulation";
        }
    }

}

int main() {
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);

    // ------------------INITIALIZE SYSTEM------------------//

    const size_t MAX_FPS = 100; // frame cap for output/write loop (set 0 to disable)
    ParticleSystem system;
    ParticleSystem initialSystem;
    bool hasLoadedScenario = false;
    atomic<bool> isSimRunning{false};

    RuntimeControlState runtimeControls;
    SimulationControlBridge controlBridge(runtimeControls);

    int currentFrame = 0;

    cout << "Awaiting scenario:start websocket message from Master before simulation begins.\n";

    FrameBroadcaster* broadcasterPtr = nullptr;

    // start WebSocket broadcaster on ws://localhost:8080/frames
    FrameBroadcaster broadcaster(
        8080,
        [&controlBridge, &isSimRunning, &broadcasterPtr](const string& message) {
            cout << "[ws] received from master: " << message << "\n";

            if (message == "sim:console" || message == "sim:stop") {
                isSimRunning = false;
                controlBridge.enqueueMessage("control:set?paused=1");
                if (broadcasterPtr) broadcasterPtr->notifySimStateChanged();
                cout << "[sim] master returned to console, simulation stopped\n";
                return;
            }

            ScenarioSelection selection;
            ostringstream scenarioErrors;
            if (parseScenarioStartMessage(message, selection, &scenarioErrors)) {
                controlBridge.enqueueScenarioStart(selection);
                cout << "[scenario] queued scenario:start request\n";
                return;
            }

            if (!scenarioErrors.str().empty()) {
                cout << "[scenario] invalid scenario:start request: "
                     << scenarioErrors.str();
                return;
            }

            if (!controlBridge.enqueueMessage(message))
                cout << "[control] ignored invalid message\n";
        },
        [&controlBridge]() {
            return encodeControlStateMessage(controlBridge.snapshot());
        },
        [&isSimRunning]() {
            return isSimRunning.load();
        },
        [&controlBridge, &isSimRunning, &broadcasterPtr]() {
            cout << "[auth] Master disconnected -> auto-pausing simulation\n";
            isSimRunning = false;
            controlBridge.enqueueMessage("control:set?paused=1");
            if (broadcasterPtr) broadcasterPtr->notifySimStateChanged();
        });

    broadcasterPtr = &broadcaster;

    flatbuffers::FlatBufferBuilder frameBuilder(1024);

    const auto targetFrameDuration =
        (MAX_FPS > 0)
            ? chrono::duration_cast<chrono::steady_clock::duration>(
                chrono::duration<double>(1.0 / static_cast<double>(MAX_FPS)))
            : chrono::steady_clock::duration::zero();

    // ---------------------PHYSICS LOOP---------------------//
    cout << "Starting physics loop. Waiting for frontend scenario selection...\n";

    chrono::duration<double> totalTime;
    auto startTime = chrono::high_resolution_clock::now();
    chrono::duration<double> activeRunTime{0};
    auto activeSegmentStart = chrono::steady_clock::now();
    bool activeSegmentOpen = false;

        // the core execution loop
        while (g_running) {
            const ControlDrainResult controlUpdate = controlBridge.drainPending();
            runtimeControls = controlUpdate.state;
            bool shouldBroadcastControlState = controlUpdate.stateChanged;

            if (controlUpdate.scenarioStartSelection.has_value()) {
                ParticleSystem loadedSystem;
                cout << "[scenario] loading requested scenario...\n";

                if (!loadSelectedScenario(loadedSystem, *controlUpdate.scenarioStartSelection, cout)) {
                    cout << "[scenario] failed to load requested scenario\n";
                } else if (loadedSystem.size() == 0) {
                    cout << "[scenario] requested scenario loaded zero bodies\n";
                } else {
                    initializeForces(loadedSystem);

                    runtimeControls.defaultDt = scenarioDefaultDt(*controlUpdate.scenarioStartSelection);
                    runtimeControls.dt = runtimeControls.defaultDt;
                    runtimeControls.paused = DEFAULT_SIM_PAUSED;
                    controlBridge.replaceState(runtimeControls);
                    shouldBroadcastControlState = true;

                    system = loadedSystem;
                    initialSystem = system;
                    hasLoadedScenario = true;
                    isSimRunning = true;
                    broadcaster.setScenarioTitle(scenarioTitleFromSelection(*controlUpdate.scenarioStartSelection));
                    broadcaster.notifySimStateChanged();
                    currentFrame = 0;

                    cout << "[scenario] loaded successfully with "
                         << system.size() << " bodies\n";
                }
            }

            if (controlUpdate.resetRequested && hasLoadedScenario) {
                system = initialSystem;
                currentFrame = 0;
            }

            if (shouldBroadcastControlState) {
                const string controlStateMessage = encodeControlStateMessage(runtimeControls);
                cout << "[control] state: " << controlStateMessage << "\n";
                broadcaster.broadcastText(controlStateMessage);
            }

            const auto loopNow = chrono::steady_clock::now();
            if (!hasLoadedScenario || runtimeControls.paused) {
                if (activeSegmentOpen) {
                    activeRunTime += loopNow - activeSegmentStart;
                    activeSegmentOpen = false;
                }
                this_thread::sleep_for(PAUSED_POLL_INTERVAL);
                continue;
            }

            if (!activeSegmentOpen) {
                activeSegmentStart = loopNow;
                activeSegmentOpen = true;
            }

            auto frameStart = chrono::steady_clock::now();
            auto computeStart = chrono::high_resolution_clock::now();

                // execute one step of the Velocity Verlet and Barnes-Hut algorithm
                physicsTick(system, runtimeControls.dt);

            auto computeEnd = chrono::high_resolution_clock::now();
            chrono::duration<double, milli> frameTime = computeEnd - computeStart;

            // stream simulation data for every frame as interleaved FlatBuffers
            broadcastFrame(system, currentFrame, frameBuilder, broadcaster);

            if (MAX_FPS > 0) {
                const auto targetFrameEnd = frameStart + targetFrameDuration;
                #if defined(_WIN32)
                    // Windows sleep granularity is often too coarse for 5ms pacing; 
                    while (chrono::steady_clock::now() < targetFrameEnd)
                        this_thread::yield();
                #else
                    this_thread::sleep_until(targetFrameEnd);
                #endif
            }
            
            // output performance metrics every 50 frames
            if (currentFrame % 50 == 0) 
                cout << "Frame: " << currentFrame
                     << " | Bodies: " << system.size()
                     << " | Compute Time: " << frameTime.count() << " ms\n";
            currentFrame++;
        }

    auto endTime = chrono::high_resolution_clock::now();
    totalTime = endTime - startTime;

    if (activeSegmentOpen) {
        activeRunTime += chrono::steady_clock::now() - activeSegmentStart;
    }

    // ---------------------OUTPUT RESULTS---------------------//    
    double averageFPS =
        activeRunTime.count() > 0.0
            ? static_cast<double>(currentFrame) / activeRunTime.count()
            : 0.0;
    
    cout << "Benchmark complete.\n";
    cout << "Total Time: " << totalTime.count() << " seconds.\n";
    cout << "Average FPS: " << averageFPS << "\n";

    broadcaster.stop();

    return 0;
}
