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
        return (selection.kind == ScenarioKind::GalaxyCollision || selection.kind == ScenarioKind::GalaxyCollision15k)
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

    struct BoundingBox {
        float minX = 0.0f, minY = 0.0f, minZ = 0.0f;
        float extentX = 1.0f, extentY = 1.0f, extentZ = 1.0f;
    };

    struct BoundingBoxState {
        BoundingBox bbox;
        bool initialized = false;

        void reset() {
            initialized = false;
        }
    };

    BoundingBox computeQuantizationBounds(const ParticleSystem& system, BoundingBoxState& state) {
        const size_t n = system.size();
        if (n == 0) return {};

        float absMinX = std::numeric_limits<float>::max();
        float absMaxX = -std::numeric_limits<float>::max();
        float absMinY = std::numeric_limits<float>::max();
        float absMaxY = -std::numeric_limits<float>::max();
        float absMinZ = std::numeric_limits<float>::max();
        float absMaxZ = -std::numeric_limits<float>::max();

        for (const BodyBlock& blk : system.blocks) {
            for (size_t lane = 0; lane < blk.count; ++lane) {
                const float x = blk.posX[lane];
                const float y = blk.posY[lane];
                const float z = blk.posZ[lane];
                if (x < absMinX) absMinX = x;
                if (x > absMaxX) absMaxX = x;
                if (y < absMinY) absMinY = y;
                if (y > absMaxY) absMaxY = y;
                if (z < absMinZ) absMinZ = z;
                if (z > absMaxZ) absMaxZ = z;
            }
        }

        // Fast-path bypass: if bounding box is already initialized and all particles
        // (including any potential outliers) are comfortably within the existing bounding box,
        // we can immediately reuse state.bbox without copying arrays or running std::nth_element.
        if (state.initialized) {
            const float thX = state.bbox.extentX * 0.02f;
            const float thY = state.bbox.extentY * 0.02f;
            const float thZ = state.bbox.extentZ * 0.02f;
            const bool insideX = (absMinX >= state.bbox.minX + thX) && (absMaxX <= state.bbox.minX + state.bbox.extentX - thX);
            const bool insideY = (absMinY >= state.bbox.minY + thY) && (absMaxY <= state.bbox.minY + state.bbox.extentY - thY);
            const bool insideZ = (absMinZ >= state.bbox.minZ + thZ) && (absMaxZ <= state.bbox.minZ + state.bbox.extentZ - thZ);
            if (insideX && insideY && insideZ) {
                return state.bbox;
            }
        }

        float candMinX = absMinX; float candMaxX = absMaxX;
        float candMinY = absMinY; float candMaxY = absMaxY;
        float candMinZ = absMinZ; float candMaxZ = absMaxZ;

        // Outlier mitigation: for systems with > 32 particles, compute robust percentiles
        // so that runaway slingshotted particles do not destroy quantization resolution.
        if (n > 32) {
            static thread_local std::vector<float> scratchX;
            static thread_local std::vector<float> scratchY;
            static thread_local std::vector<float> scratchZ;
            scratchX.resize(n);
            scratchY.resize(n);
            scratchZ.resize(n);

            size_t idx = 0;
            for (const BodyBlock& blk : system.blocks) {
                for (size_t lane = 0; lane < blk.count; ++lane) {
                    scratchX[idx] = blk.posX[lane];
                    scratchY[idx] = blk.posY[lane];
                    scratchZ[idx] = blk.posZ[lane];
                    ++idx;
                }
            }

            const size_t k1 = static_cast<size_t>(n * 0.01f);
            size_t k2 = static_cast<size_t>(n * 0.99f);
            if (k2 >= n) k2 = n - 1;

            auto getRobustRange = [&](std::vector<float>& arr, float absMin, float absMax, float& outMin, float& outMax) {
                std::nth_element(arr.begin(), arr.begin() + k1, arr.end());
                const float p1 = arr[k1];
                std::nth_element(arr.begin() + k1 + 1, arr.begin() + k2, arr.end());
                const float p99 = arr[k2];
                const float span = std::max(p99 - p1, 1e-4f);
                // Allow tight 15% margin beyond 1st/99th percentiles before clamping outliers
                // to maximize 16-bit coordinate resolution over the active particle core.
                const float robustMin = p1 - 0.15f * span;
                const float robustMax = p99 + 0.15f * span;
                outMin = std::max(absMin, robustMin);
                outMax = std::min(absMax, robustMax);
                if (outMax <= outMin) outMax = outMin + 1e-4f;
            };

            getRobustRange(scratchX, absMinX, absMaxX, candMinX, candMaxX);
            getRobustRange(scratchY, absMinY, absMaxY, candMinY, candMaxY);
            getRobustRange(scratchZ, absMinZ, absMaxZ, candMinZ, candMaxZ);
        }

        if (!state.initialized) {
            // Generous initial padding (15%) so the bounding box doesn't need to expand right away
            auto initAxis = [](float cMin, float cMax, float& outMin, float& outExtent) {
                const float span = std::max(cMax - cMin, 1e-4f);
                const float pad = span * 0.15f;
                outMin = cMin - pad;
                outExtent = std::max(span + 2.0f * pad, 1e-4f);
            };
            initAxis(candMinX, candMaxX, state.bbox.minX, state.bbox.extentX);
            initAxis(candMinY, candMaxY, state.bbox.minY, state.bbox.extentY);
            initAxis(candMinZ, candMaxZ, state.bbox.minZ, state.bbox.extentZ);
            state.initialized = true;
            return state.bbox;
        }

        // Hysteresis: only expand the bounding box when particles come within 2% of the boundary
        // or exceed it. When expanding, add a generous 20% margin to prevent frame-by-frame expansion.
        auto updateAxisHysteresis = [](float cMin, float cMax, float& boxMin, float& boxExtent) {
            float boxMax = boxMin + boxExtent;
            const float threshold = boxExtent * 0.02f;
            bool changed = false;

            if (cMin < boxMin + threshold) {
                const float span = std::max(cMax - cMin, 1e-4f);
                boxMin = cMin - span * 0.10f;
                changed = true;
            }
            if (cMax > boxMax - threshold) {
                const float span = std::max(cMax - cMin, 1e-4f);
                boxMax = cMax + span * 0.10f;
                changed = true;
            }
            if (changed) {
                boxExtent = std::max(boxMax - boxMin, 1e-4f);
            }
        };

        updateAxisHysteresis(candMinX, candMaxX, state.bbox.minX, state.bbox.extentX);
        updateAxisHysteresis(candMinY, candMaxY, state.bbox.minY, state.bbox.extentY);
        updateAxisHysteresis(candMinZ, candMaxZ, state.bbox.minZ, state.bbox.extentZ);

        return state.bbox;
    }

    void broadcastFrame(const ParticleSystem& system,
                        int frame,
                        float simDt,
                        flatbuffers::FlatBufferBuilder& builder,
                        FrameBroadcaster& broadcaster,
                        BoundingBoxState& bboxState) {
        builder.Clear();

        const size_t bodyCount = system.size();
        const BoundingBox bbox = computeQuantizationBounds(system, bboxState);

        uint16_t* interleaved = nullptr;
        const auto bodies = builder.CreateUninitializedVector<uint16_t>(bodyCount * 3, &interleaved);

        const float invExtentX = 65535.0f / bbox.extentX;
        const float invExtentY = 65535.0f / bbox.extentY;
        const float invExtentZ = 65535.0f / bbox.extentZ;

        size_t writeIdx = 0;
        for (const BodyBlock& blk : system.blocks) {
            for (size_t lane = 0; lane < blk.count; ++lane) {
                float normX = (blk.posX[lane] - bbox.minX) * invExtentX;
                float normY = (blk.posY[lane] - bbox.minY) * invExtentY;
                float normZ = (blk.posZ[lane] - bbox.minZ) * invExtentZ;

                if (normX < 0.0f) normX = 0.0f; else if (normX > 65535.0f) normX = 65535.0f;
                if (normY < 0.0f) normY = 0.0f; else if (normY > 65535.0f) normY = 65535.0f;
                if (normZ < 0.0f) normZ = 0.0f; else if (normZ > 65535.0f) normZ = 65535.0f;

                interleaved[writeIdx++] = static_cast<uint16_t>(normX + 0.5f);
                interleaved[writeIdx++] = static_cast<uint16_t>(normY + 0.5f);
                interleaved[writeIdx++] = static_cast<uint16_t>(normZ + 0.5f);
            }
        }

        const auto sample = nbody::CreateFrameSample(
            builder,
            static_cast<uint32_t>(frame),
            static_cast<uint32_t>(bodyCount),
            simDt,
            bbox.minX,
            bbox.minY,
            bbox.minZ,
            bbox.extentX,
            bbox.extentY,
            bbox.extentZ,
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
            case ScenarioKind::Galaxy:
            case ScenarioKind::Galaxy10k:
                return "Galaxy";
            case ScenarioKind::GalaxyCollision:
            case ScenarioKind::GalaxyCollision15k:
                return "Galaxy Collision";
            case ScenarioKind::StableOrbits:
                return "Stable Orbits";
            case ScenarioKind::AccretionDisk:
                return "Accretion Disk";
            default:
                return "Simulation";
        }
    }

    size_t calculateAdaptiveTargetFps(size_t bodyCount) {
        if (bodyCount <= 3) return 240;
        if (bodyCount <= 4000) return 60;
        return 30; // 30Hz target rate for Galaxy and large particle systems
    }

}

int main(int argc, char* argv[]) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    std::cout << std::unitbuf;
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);

    bool locallyHosted = false;
    bool resetLimit = false;
    bool resetOnly = false;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--locally-hosted" || arg == "-lh" || arg == "--local") {
            locallyHosted = true;
        } else if (arg == "--reset-limit" || arg == "-rl" || arg == "--reset-quota") {
            resetLimit = true;
        } else if (arg == "--reset-only") {
            resetLimit = true;
            resetOnly = true;
        } else if (arg == "--help" || arg == "-h") {
            cout << "Usage: nbody_ws [options]\n"
                 << "Options:\n"
                 << "  --locally-hosted, -lh, --local   Run in local mode (disable password auth & compute quota)\n"
                 << "  --reset-limit, -rl               Reset tracked daily compute usage and password attempts to 0\n"
                 << "  --reset-only                     Reset compute usage and password attempts, then exit immediately\n"
                 << "  --help, -h                       Show this help message\n";
            return 0;
        }
    }

    if (locallyHosted) {
        cout << "[mode] Running in locally-hosted mode (--locally-hosted / -lh): login system and daily compute limits are DISABLED.\n";
    } else {
        cout << "[mode] Running in hosted mode (default): password protection and 1h daily compute limit ENABLED.\n";
    }

    // ------------------INITIALIZE SYSTEM------------------//

    size_t targetFps = 60; // dynamic target FPS that scales with body count
    ParticleSystem system;
    ParticleSystem initialSystem;
    atomic<bool> hasLoadedScenario{false};
    atomic<bool> isSimRunning{false};

    RuntimeControlState runtimeControls;
    SimulationControlBridge controlBridge(runtimeControls);

    int currentFrame = 0;

    ComputeQuotaManager quotaManager;
    if (resetLimit) {
        quotaManager.resetQuotaAndAttempts();
        if (resetOnly) {
            cout << "[quota] Exiting after reset (--reset-only specified).\n";
            return 0;
        }
    }

    if (locallyHosted) {
        cout << "Awaiting scenario:start websocket message before simulation begins.\n";
    } else {
        cout << "Awaiting scenario:start websocket message from Master before simulation begins.\n";
    }

    FrameBroadcaster* broadcasterPtr = nullptr;

    // start WebSocket broadcaster on ws://localhost:8080/frames
    FrameBroadcaster broadcaster(
        8080,
        &quotaManager,
        locallyHosted,
        [&controlBridge, &isSimRunning, &hasLoadedScenario, &broadcasterPtr, &quotaManager, locallyHosted](const string& message) {
            cout << "[ws] received command: " << message << "\n";

            if (message == "sim:console" || message == "sim:stop") {
                isSimRunning = false;
                hasLoadedScenario = false;
                controlBridge.enqueueMessage("control:set?paused=1");
                if (broadcasterPtr) {
                    broadcasterPtr->clearFrames();
                    broadcasterPtr->notifySimStateChanged();
                }
                cout << "[sim] returned to console, simulation stopped\n";
                return;
            }

            if (!locallyHosted && quotaManager.isComputeExhausted()) {
                cout << "[quota] Blocked command: daily compute limit reached.\n";
                if (broadcasterPtr) {
                    broadcasterPtr->broadcastText("auth:error?reason=" + nbody_auth::urlEncode("Daily compute limit reached. Please return tomorrow to continue using the simulation."));
                }
                return;
            }

            ScenarioSelection selection;
            ostringstream scenarioErrors;
            if (parseScenarioStartMessage(message, selection, &scenarioErrors)) {
                isSimRunning = false;
                hasLoadedScenario = false;
                if (broadcasterPtr) {
                    broadcasterPtr->clearFrames();
                    broadcasterPtr->notifySimStateChanged();
                }
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
        [&controlBridge, &isSimRunning, &hasLoadedScenario, &broadcasterPtr]() {
            cout << "[auth] Master connection dropped. Halting simulation and returning to lobby.\n";
            isSimRunning = false;
            hasLoadedScenario = false;
            controlBridge.enqueueMessage("control:set?paused=1");
            if (broadcasterPtr) {
                broadcasterPtr->clearFrames();
                broadcasterPtr->notifySimStateChanged();
            }
        });

    broadcasterPtr = &broadcaster;

    flatbuffers::FlatBufferBuilder frameBuilder(1024);
    BoundingBoxState bboxState;

    auto targetFrameDuration =
        (targetFps > 0)
            ? chrono::duration_cast<chrono::steady_clock::duration>(
                chrono::duration<double>(1.0 / static_cast<double>(targetFps)))
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
                    hasLoadedScenario = false;
                    isSimRunning = false;
                    broadcaster.notifySimStateChanged();
                    broadcaster.broadcastText("auth:error?reason=" + nbody_auth::urlEncode("Failed to generate or load scenario"));
                } else if (loadedSystem.size() == 0) {
                    cout << "[scenario] requested scenario loaded zero bodies\n";
                    hasLoadedScenario = false;
                    isSimRunning = false;
                    broadcaster.notifySimStateChanged();
                    broadcaster.broadcastText("auth:error?reason=" + nbody_auth::urlEncode("Scenario generated zero bodies"));
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
                    currentFrame = 0;
                    bboxState.reset();
                    broadcaster.clearFrames();
                    broadcaster.setScenarioTitle(scenarioTitleFromSelection(*controlUpdate.scenarioStartSelection));
                    broadcaster.notifySimStateChanged();

                    targetFps = calculateAdaptiveTargetFps(system.size());
                    targetFrameDuration = chrono::duration_cast<chrono::steady_clock::duration>(
                        chrono::duration<double>(1.0 / static_cast<double>(targetFps)));

                    cout << "[scenario] loaded successfully with "
                         << system.size() << " bodies (adaptive target: " << targetFps << " FPS)\n";
                }
            }

            if (controlUpdate.resetRequested && hasLoadedScenario) {
                system = initialSystem;
                currentFrame = 0;
                bboxState.reset();
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
            broadcastFrame(system, currentFrame, runtimeControls.dt, frameBuilder, broadcaster, bboxState);

            if (targetFps > 0) {
                const auto targetFrameEnd = frameStart + targetFrameDuration;
                #if defined(_WIN32)
                    while (true) {
                        const auto now = chrono::steady_clock::now();
                        if (now >= targetFrameEnd) break;
                        const auto remaining = chrono::duration_cast<chrono::milliseconds>(targetFrameEnd - now);
                        if (remaining.count() > 2) {
                            this_thread::sleep_for(chrono::milliseconds(1));
                        } else {
                            this_thread::yield();
                        }
                    }
                #else
                    this_thread::sleep_until(targetFrameEnd);
                #endif
            }

            if (!locallyHosted) {
                const auto frameEnd = chrono::steady_clock::now();
                const double frameElapsedSeconds = chrono::duration<double>(frameEnd - frameStart).count();
                if (quotaManager.addComputeSeconds(frameElapsedSeconds)) {
                    cout << "[quota] Daily compute limit of 1 hour reached! Halting simulation.\n";
                    runtimeControls.paused = true;
                    isSimRunning = false;
                    controlBridge.replaceState(runtimeControls);
                    broadcaster.broadcastText(encodeControlStateMessage(runtimeControls));
                    broadcaster.notifySimStateChanged();
                    continue;
                }
            }

            // Output performance metrics every 50 frames
            if (currentFrame % 50 == 0) 
                cout << "Frame: " << currentFrame
                     << " | Bodies: " << system.size()
                     << " | Compute Time: " << frameTime.count() << " ms\n";

            // Sync compute gauge, auth state, and touch activity heartbeat every 60 frames (~0.6-1.0s)
            if (currentFrame % 60 == 0) {
                nbody_auth::touchActivityFile();
                broadcaster.notifySimStateChanged();
            }
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
