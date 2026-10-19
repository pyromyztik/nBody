#pragma once

#include <App.h>
#include <atomic>
#include <cctype>
#include <cstdlib>
#include <functional>
#include <future>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "computeQuotaManager.hpp"

namespace nbody_auth {

inline std::string urlDecode(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '+') {
            out += ' ';
        } else if (in[i] == '%' && i + 2 < in.size()) {
            int hexVal = 0;
            std::istringstream hexStream(in.substr(i + 1, 2));
            if (hexStream >> std::hex >> hexVal) {
                out += static_cast<char>(hexVal);
                i += 2;
            } else {
                out += in[i];
            }
        } else {
            out += in[i];
        }
    }
    return out;
}

inline std::string urlEncode(const std::string& in) {
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex;
    for (char c : in) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') {
            escaped << c;
        } else if (c == ' ') {
            escaped << '+';
        } else {
            escaped << '%' << std::setw(2) << std::uppercase << (static_cast<int>(static_cast<unsigned char>(c)));
        }
    }
    return escaped.str();
}

inline std::string buildAuthStateMessage(
    bool hasMaster,
    const std::string& masterName,
    int spectatorCount,
    int maxSpectators,
    bool isSimRunning,
    const std::string& scenarioTitle = "",
    double usedCompute = 0.0,
    double maxCompute = 5400.0,
    double computeRemaining = 5400.0,
    bool computeExhausted = false,
    bool loginLocked = false,
    int remainingAttempts = 5,
    bool locallyHosted = false
) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);
    ss << "auth:state?hasMaster=" << (hasMaster ? 1 : 0)
       << "&masterName=" << urlEncode(masterName)
       << "&spectatorCount=" << spectatorCount
       << "&maxSpectators=" << maxSpectators
       << "&isSimRunning=" << (isSimRunning ? 1 : 0)
       << "&scenario=" << urlEncode(scenarioTitle)
       << "&usedCompute=" << usedCompute
       << "&maxCompute=" << maxCompute
       << "&computeRemaining=" << computeRemaining
       << "&computeExhausted=" << (computeExhausted ? 1 : 0)
       << "&loginLocked=" << (loginLocked ? 1 : 0)
       << "&remainingAttempts=" << remainingAttempts
       << "&locallyHosted=" << (locallyHosted ? 1 : 0);
    return ss.str();
}

} // namespace nbody_auth

class FrameBroadcaster {
public:
    using TextMessageHandler = std::function<void(const std::string&)>;
    using InitialTextMessageProvider = std::function<std::string()>;
    using SimRunningProvider = std::function<bool()>;
    using MasterDisconnectedHandler = std::function<void()>;

    static constexpr int MAX_SPECTATORS = 6;

    void setScenarioTitle(const std::string& title) {
        std::lock_guard<std::mutex> lock(scenarioTitleMutex_);
        scenarioTitle_ = title;
    }

    std::string getScenarioTitle() {
        std::lock_guard<std::mutex> lock(scenarioTitleMutex_);
        return scenarioTitle_;
    }

    FrameBroadcaster(
        unsigned short port,
        ComputeQuotaManager* quotaManager = nullptr,
        bool locallyHosted = false,
        TextMessageHandler onTextMessage = {},
        InitialTextMessageProvider initialTextMessageProvider = {},
        SimRunningProvider isSimRunning = {},
        MasterDisconnectedHandler onMasterDisconnected = {}
    ) : quotaManager_(quotaManager),
        locallyHosted_(locallyHosted),
        onTextMessage_(std::move(onTextMessage)),
        initialTextMessageProvider_(std::move(initialTextMessageProvider)),
        isSimRunning_(std::move(isSimRunning)),
        onMasterDisconnected_(std::move(onMasterDisconnected)) {

        if (locallyHosted_) {
            std::cout << "[auth] Running in locally-hosted mode: password auth and limits bypassed.\n";
        } else {
            const char* envPwd = std::getenv("SIM_MASTER_PASSWORD");
            masterPassword_ = (envPwd && envPwd[0] != '\0') ? std::string(envPwd) : "s#w1Ft!@5173";
            std::cout << "[auth] Master password configured: " << masterPassword_ << "\n";
        }

        serverThread_ = std::thread([this, port]() {
            struct PerSocketData {
                bool isMaster = false;
                bool isSpectator = false;
                std::string clientName;
            };

            uWS::App app;
            app_ = &app;
            loop_ = uWS::Loop::get();

            auto getQuotaInfo = [this](double& used, double& maxC, double& rem, bool& exh, bool& locked, int& attempts, const std::string& ip = "") {
                if (quotaManager_) {
                    used = quotaManager_->getUsedComputeSeconds();
                    maxC = quotaManager_->getMaxComputeSeconds();
                    rem = quotaManager_->getRemainingComputeSeconds();
                    exh = quotaManager_->isComputeExhausted();
                    locked = quotaManager_->isLoginLocked(ip);
                    attempts = quotaManager_->getRemainingLoginAttempts(ip);
                } else {
                    used = 0.0;
                    maxC = 5400.0;
                    rem = 5400.0;
                    exh = false;
                    locked = false;
                    attempts = 5;
                }
            };

            auto sendAuthState = [this, getQuotaInfo](auto* ws) {
                if (locallyHosted_) {
                    bool simRunning = isSimRunning_ ? isSimRunning_() : false;
                    std::string title = getScenarioTitle();
                    std::string msg = nbody_auth::buildAuthStateMessage(
                        true, "Local Operator", 0, 0, simRunning, title,
                        0.0, 0.0, 0.0, false, false, 5, true);
                    ws->send(msg, uWS::OpCode::TEXT);
                    return;
                }
                bool hasMaster = (currentMasterWs_ != nullptr);
                bool simRunning = isSimRunning_ ? isSimRunning_() : false;
                std::string title = getScenarioTitle();
                std::string ip(ws->getRemoteAddressAsText());
                double used = 0, maxC = 5400, rem = 5400; bool exh = false, locked = false; int attempts = 5;
                getQuotaInfo(used, maxC, rem, exh, locked, attempts, ip);
                std::string msg = nbody_auth::buildAuthStateMessage(
                    hasMaster, masterName_, spectatorCount_, MAX_SPECTATORS, simRunning, title,
                    used, maxC, rem, exh, locked, attempts, false);
                ws->send(msg, uWS::OpCode::TEXT);
            };

            auto broadcastAuthState = [this, getQuotaInfo]() {
                if (locallyHosted_) {
                    bool simRunning = isSimRunning_ ? isSimRunning_() : false;
                    std::string title = getScenarioTitle();
                    std::string msg = nbody_auth::buildAuthStateMessage(
                        true, "Local Operator", 0, 0, simRunning, title,
                        0.0, 0.0, 0.0, false, false, 5, true);
                    broadcastText(msg);
                    return;
                }
                bool hasMaster = (currentMasterWs_ != nullptr);
                bool simRunning = isSimRunning_ ? isSimRunning_() : false;
                std::string title = getScenarioTitle();
                double used = 0, maxC = 5400, rem = 5400; bool exh = false, locked = false; int attempts = 5;
                getQuotaInfo(used, maxC, rem, exh, locked, attempts);
                std::string msg = nbody_auth::buildAuthStateMessage(
                    hasMaster, masterName_, spectatorCount_, MAX_SPECTATORS, simRunning, title,
                    used, maxC, rem, exh, locked, attempts, false);
                broadcastText(msg);
            };

            broadcastAuthState_ = broadcastAuthState;

            app.template ws<PerSocketData>("/*", {
                .compression = uWS::DISABLED,
                .maxPayloadLength = 64 * 1024,
                .idleTimeout = 120,
                .maxBackpressure = 64 * 1024 * 1024,
                .open = [this, sendAuthState, broadcastAuthState](auto* ws) {
                    auto* data = ws->getUserData();
                    data->isMaster = false;
                    data->isSpectator = false;
                    data->clientName = "";

                    if (locallyHosted_) {
                        data->isMaster = true;
                        data->isSpectator = false;
                        data->clientName = "Local Operator";
                        currentMasterWs_ = ws;
                        ws->subscribe("frames");
                        sendAuthState(ws);
                        if (initialTextMessageProvider_) {
                            std::string initMsg = initialTextMessageProvider_();
                            if (!initMsg.empty()) {
                                ws->send(initMsg, uWS::OpCode::TEXT);
                            }
                        }
                        return;
                    }

                    // Max connections: 1 master + 6 spectators = 7
                    // If master exists and spectator count is already at max, server is full.
                    if (currentMasterWs_ != nullptr && spectatorCount_ >= MAX_SPECTATORS) {
                        std::cout << "[auth] Connection rejected: server is full (1 master + "
                                  << MAX_SPECTATORS << " spectators)\n";
                        ws->send("auth:error?reason=" + nbody_auth::urlEncode("Server is full (max 6 spectators)"), uWS::OpCode::TEXT);
                        ws->end(1008, "Server is full (max 6 spectators)");
                        return;
                    }

                    // Assign spectator role if slot available
                    if (spectatorCount_ < MAX_SPECTATORS) {
                        data->isSpectator = true;
                        spectatorCount_++;
                        std::cout << "[ws] client connected as spectator. Total spectators: "
                                  << spectatorCount_ << "/" << MAX_SPECTATORS << "\n";
                    } else {
                        // All spectator slots taken, but master slot is open.
                        // Allow connection as pending so user can enter password to become master.
                        std::cout << "[ws] client connected as unauthenticated pending (master slot available)\n";
                    }

                    ws->subscribe("frames");

                    // Send current auth state to new client
                    sendAuthState(ws);

                    // Send current simulation control state (paused, dt, defaultDt)
                    if (initialTextMessageProvider_) {
                        std::string initMsg = initialTextMessageProvider_();
                        if (!initMsg.empty()) {
                            ws->send(initMsg, uWS::OpCode::TEXT);
                        }
                    }

                    // Notify all other clients of updated spectator count
                    broadcastAuthState();
                },
                .message = [this, sendAuthState, broadcastAuthState](auto* ws, std::string_view rawMessage, uWS::OpCode opCode) {
                    if (opCode != uWS::OpCode::TEXT) return;
                    std::string message(rawMessage);
                    auto* data = ws->getUserData();

                    if (locallyHosted_) {
                        if (onTextMessage_) {
                            onTextMessage_(message);
                        }
                        return;
                    }

                    // Handle authentication commands
                    constexpr std::string_view LOGIN_PREFIX = "auth:login?";
                    if (message.rfind(LOGIN_PREFIX.data(), 0) == 0) {
                        std::string query = message.substr(LOGIN_PREFIX.size());
                        std::string password;
                        std::string name = "Master";

                        size_t start = 0;
                        while (start <= query.size()) {
                            size_t end = query.find('&', start);
                            std::string pair = query.substr(start, end == std::string::npos ? std::string::npos : end - start);
                            if (!pair.empty()) {
                                size_t eq = pair.find('=');
                                std::string key = pair.substr(0, eq);
                                std::string val = (eq == std::string::npos) ? "" : pair.substr(eq + 1);
                                if (key == "password") password = nbody_auth::urlDecode(val);
                                else if (key == "name" && !val.empty()) name = nbody_auth::urlDecode(val);
                            }
                            if (end == std::string::npos) break;
                            start = end + 1;
                        }

                        std::string clientIp(ws->getRemoteAddressAsText());

                        if (quotaManager_) {
                            auto verifyRes = quotaManager_->verifyAndRecordLogin(password, masterPassword_, clientIp);
                            if (!verifyRes.allowed) {
                                std::cout << "[auth] Failed master login attempt from " << clientIp << ": " << verifyRes.errorMessage << "\n";
                                ws->send("auth:error?reason=" + nbody_auth::urlEncode(verifyRes.errorMessage), uWS::OpCode::TEXT);
                                broadcastAuthState();
                                return;
                            }
                        } else {
                            if (password != masterPassword_) {
                                std::cout << "[auth] Failed master login attempt with invalid password\n";
                                ws->send("auth:error?reason=" + nbody_auth::urlEncode("Incorrect master password"), uWS::OpCode::TEXT);
                                return;
                            }
                        }

                        if (currentMasterWs_ != nullptr && currentMasterWs_ != ws) {
                            std::cout << "[auth] Failed master login attempt: master already active (" << masterName_ << ")\n";
                            ws->send("auth:error?reason=" + nbody_auth::urlEncode("Master role already taken by " + masterName_), uWS::OpCode::TEXT);
                            return;
                        }

                        // Successfully promote to Master
                        if (data->isSpectator) {
                            data->isSpectator = false;
                            spectatorCount_--;
                            if (spectatorCount_ < 0) spectatorCount_ = 0;
                        }

                        data->isMaster = true;
                        data->clientName = name;
                        currentMasterWs_ = ws;
                        masterName_ = name;

                        std::cout << "[auth] Client authenticated as Master: " << masterName_ << " (" << clientIp << ")\n";
                        ws->send("auth:ok?role=master&masterName=" + nbody_auth::urlEncode(masterName_), uWS::OpCode::TEXT);
                        broadcastAuthState();
                        return;
                    }

                    if (message == "auth:logout") {
                        if (data->isMaster) {
                            std::cout << "[auth] Master logged out: " << masterName_ << "\n";
                            data->isMaster = false;
                            currentMasterWs_ = nullptr;
                            masterName_ = "";

                            if (spectatorCount_ < MAX_SPECTATORS) {
                                data->isSpectator = true;
                                spectatorCount_++;
                            }
                            ws->send("auth:ok?role=spectator", uWS::OpCode::TEXT);
                            broadcastAuthState();
                        }
                        return;
                    }

                    if (message == "auth:status") {
                        sendAuthState(ws);
                        return;
                    }

                    // Simulation commands: MUST be from active Master
                    if (!data->isMaster) {
                        std::cout << "[auth] Rejected unauthorized command from spectator: " << message << "\n";
                        ws->send("auth:unauthorized?reason=" + nbody_auth::urlEncode("Only the Master can control the simulation"), uWS::OpCode::TEXT);
                        return;
                    }

                    // Check if compute quota is exhausted
                    if (quotaManager_ && quotaManager_->isComputeExhausted()) {
                        if (message != "control:set?paused=1" && message != "sim:console" && message != "sim:stop") {
                            std::cout << "[quota] Blocked command due to exhausted daily compute: " << message << "\n";
                            ws->send("auth:error?reason=" + nbody_auth::urlEncode("Daily compute limit reached. Please return tomorrow to continue using the simulation."), uWS::OpCode::TEXT);
                            return;
                        }
                    }

                    if (onTextMessage_) {
                        onTextMessage_(message);
                    }
                },
                .close = [this, broadcastAuthState](auto* ws, int /*code*/, std::string_view /*message*/) {
                    auto* data = ws->getUserData();
                    if (locallyHosted_) {
                        if (currentMasterWs_ == ws) {
                            currentMasterWs_ = nullptr;
                        }
                        return;
                    }

                    if (data->isMaster || currentMasterWs_ == ws) {
                        std::cout << "[auth] Master disconnected (" << masterName_ << ")\n";
                        currentMasterWs_ = nullptr;
                        masterName_ = "";
                        if (onMasterDisconnected_) {
                            onMasterDisconnected_();
                        }
                        broadcastAuthState();
                    } else if (data->isSpectator) {
                        spectatorCount_--;
                        if (spectatorCount_ < 0) spectatorCount_ = 0;
                        std::cout << "[ws] Spectator disconnected. Total spectators: "
                                  << spectatorCount_ << "/" << MAX_SPECTATORS << "\n";
                        broadcastAuthState();
                    }
                }
            }).listen(port, [this, port](us_listen_socket_t* token) {
                if (token) {
                    listenSocket_ = token;
                    std::cout << "WebSocket server listening on port " << port << " (uWebSockets)\n";
                } else {
                    std::cerr << "WebSocket failed to listen on port " << port << "\n";
                }
                readyPromise_.set_value();
            });

            app.run();
        });

        readyPromise_.get_future().wait();
    }

    void notifySimStateChanged() {
        if (!loop_) return;
        loop_->defer([this]() {
            if (broadcastAuthState_) {
                broadcastAuthState_();
            }
        });
    }

    void notifyQuotaChanged() {
        notifySimStateChanged();
    }

    void broadcast(const std::shared_ptr<std::vector<uint8_t>>& payload) {
        if (!payload || !loop_) return;

        {
            std::lock_guard<std::mutex> lock(frameMutex_);
            latestFrame_ = payload;
        }

        loop_->defer([this]() {
            std::shared_ptr<std::vector<uint8_t>> frame;
            {
                std::lock_guard<std::mutex> lock(frameMutex_);
                frame = std::move(latestFrame_);
            }
            if (frame && app_) {
                app_->publish("frames",
                    std::string_view(reinterpret_cast<const char*>(frame->data()), frame->size()),
                    uWS::OpCode::BINARY);
            }
        });
    }

    void broadcastText(const std::string& message) {
        if (!loop_) return;
        loop_->defer([this, message]() {
            if (app_) {
                app_->publish("frames", message, uWS::OpCode::TEXT);
            }
        });
    }

    void stop() {
        if (stopped_.exchange(true)) return;
        if (loop_) {
            loop_->defer([this]() {
                if (listenSocket_) {
                    us_listen_socket_close(0, listenSocket_);
                    listenSocket_ = nullptr;
                }
                if (app_) {
                    app_->close();
                }
            });
        }
        if (serverThread_.joinable()) {
            serverThread_.join();
        }
    }

    ~FrameBroadcaster() {
        stop();
    }

private:
    ComputeQuotaManager* quotaManager_ = nullptr;
    bool locallyHosted_ = false;
    std::function<void()> broadcastAuthState_;
    TextMessageHandler onTextMessage_;
    InitialTextMessageProvider initialTextMessageProvider_;
    SimRunningProvider isSimRunning_;
    MasterDisconnectedHandler onMasterDisconnected_;
    std::promise<void> readyPromise_;
    std::thread serverThread_;
    uWS::App* app_ = nullptr;
    uWS::Loop* loop_ = nullptr;
    us_listen_socket_t* listenSocket_ = nullptr;

    std::string masterPassword_;
    void* currentMasterWs_ = nullptr;
    std::string masterName_;
    int spectatorCount_ = 0;

    std::mutex frameMutex_;
    std::shared_ptr<std::vector<uint8_t>> latestFrame_;
    std::mutex scenarioTitleMutex_;
    std::string scenarioTitle_ = "Galaxy";
    std::atomic<bool> stopped_{false};
};
