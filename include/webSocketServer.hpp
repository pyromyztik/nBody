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
#include <unordered_set>
#include <vector>

#include "computeQuotaManager.hpp"

namespace nbody_auth {

inline bool isAllowedOrigin(std::string_view origin) {
    if (origin.empty()) {
        // Direct non-browser tools / CLI / tests
        return true;
    }
    // Production domains
    if (origin == "https://pyromyztik.me" || origin == "http://pyromyztik.me" ||
        origin == "https://pyromyztik.github.io" || origin == "http://pyromyztik.github.io") {
        return true;
    }
    // Local development origins
    if (origin.rfind("http://localhost", 0) == 0 || origin.rfind("https://localhost", 0) == 0 ||
        origin.rfind("http://127.0.0.1", 0) == 0 || origin.rfind("https://127.0.0.1", 0) == 0) {
        return true;
    }
    return false;
}

inline void touchActivityFile() {
#if !defined(_WIN32)
    const char* envPath = std::getenv("SIM_ACTIVITY_FILE");
    const char* filePath = (envPath && envPath[0] != '\0') ? envPath : "/run/nbody/nbody_sim_active";
    FILE* f = std::fopen(filePath, "w");
    if (!f && filePath != std::string("/tmp/nbody_sim_active")) {
        // Fallback to /tmp if /run/nbody is not present
        f = std::fopen("/tmp/nbody_sim_active", "w");
    }
    if (f) {
        std::fprintf(f, "%ld\n", static_cast<long>(std::time(nullptr)));
        std::fclose(f);
    }
#endif
}

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
    double maxCompute = 3600.0,
    double computeRemaining = 3600.0,
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
            if (envPwd && envPwd[0] != '\0') {
                masterPassword_ = std::string(envPwd);
                std::cout << "[auth] Master password loaded from environment.\n";
            } else {
                masterPassword_ = "";
                std::cerr << "[auth] WARNING: SIM_MASTER_PASSWORD is not set or empty! Master authentication is DISABLED.\n";
            }
        }

        serverThread_ = std::thread([this, port]() {
            struct PerSocketData {
                bool isMaster = false;
                bool isSpectator = false;
                bool isPending = false;
                std::string clientName;
                std::string clientIp;
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
                    maxC = 3600.0;
                    rem = 3600.0;
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
                double used = 0, maxC = 3600, rem = 3600; bool exh = false, locked = false; int attempts = 5;
                getQuotaInfo(used, maxC, rem, exh, locked, attempts, ip);
                int spectatorCount = static_cast<int>(activeSpectators_.size());
                std::string msg = nbody_auth::buildAuthStateMessage(
                    hasMaster, masterName_, spectatorCount, MAX_SPECTATORS, simRunning, title,
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
                double used = 0, maxC = 3600, rem = 3600; bool exh = false, locked = false; int attempts = 5;
                getQuotaInfo(used, maxC, rem, exh, locked, attempts);
                int spectatorCount = static_cast<int>(activeSpectators_.size());
                std::string msg = nbody_auth::buildAuthStateMessage(
                    hasMaster, masterName_, spectatorCount, MAX_SPECTATORS, simRunning, title,
                    used, maxC, rem, exh, locked, attempts, false);
                broadcastText(msg);
            };

            broadcastAuthState_ = broadcastAuthState;

            app.template ws<PerSocketData>("/*", {
                .compression = uWS::DISABLED,
                .maxPayloadLength = 64 * 1024,
                .idleTimeout = 16,
                .maxBackpressure = 512 * 1024,
                .upgrade = [this](auto* res, auto* req, auto* context) {
                    std::string_view origin = req->getHeader("origin");
                    if (!locallyHosted_ && !nbody_auth::isAllowedOrigin(origin)) {
                        std::cout << "[auth] Rejected WebSocket connection from unauthorized origin: " << origin << "\n";
                        res->writeStatus("403 Forbidden")
                           ->writeHeader("Content-Type", "text/plain")
                           ->end("Unauthorized Origin");
                        return;
                    }

                    std::string realIp;
                    std::string_view xForwardedFor = req->getHeader("x-forwarded-for");
                    if (!xForwardedFor.empty()) {
                        size_t comma = xForwardedFor.find(',');
                        if (comma != std::string_view::npos) {
                            realIp = std::string(xForwardedFor.substr(0, comma));
                        } else {
                            realIp = std::string(xForwardedFor);
                        }
                        while (!realIp.empty() && realIp.front() == ' ') realIp.erase(realIp.begin());
                        while (!realIp.empty() && realIp.back() == ' ') realIp.pop_back();
                    }
                    if (realIp.empty()) {
                        std::string_view xRealIp = req->getHeader("x-real-ip");
                        if (!xRealIp.empty()) {
                            realIp = std::string(xRealIp);
                        }
                    }

                    PerSocketData socketData;
                    socketData.clientIp = realIp;

                    res->template upgrade<PerSocketData>(
                        std::move(socketData),
                        req->getHeader("sec-websocket-key"),
                        req->getHeader("sec-websocket-protocol"),
                        req->getHeader("sec-websocket-extensions"),
                        context
                    );
                },
                .open = [this, sendAuthState, broadcastAuthState](auto* ws) {
                    auto* data = ws->getUserData();
                    data->isMaster = false;
                    data->isSpectator = false;
                    data->isPending = false;
                    data->clientName = "";
                    if (data->clientIp.empty()) {
                        data->clientIp = std::string(ws->getRemoteAddressAsText());
                    }

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
                    if (currentMasterWs_ != nullptr && activeSpectators_.size() >= MAX_SPECTATORS) {
                        std::cout << "[auth] Connection rejected: server is full (1 master + "
                                  << MAX_SPECTATORS << " spectators)\n";
                        ws->send("auth:error?reason=" + nbody_auth::urlEncode("Server is full (max 6 spectators)"), uWS::OpCode::TEXT);
                        ws->end(1008, "Server is full (max 6 spectators)");
                        return;
                    }

                    // Assign spectator role if slot available
                    if (activeSpectators_.size() < MAX_SPECTATORS) {
                        data->isSpectator = true;
                        activeSpectators_.insert(ws);
                        std::cout << "[ws] client (" << data->clientIp << ") connected as spectator. Total spectators: "
                                  << activeSpectators_.size() << "/" << MAX_SPECTATORS << "\n";
                        ws->subscribe("frames");
                    } else {
                        // All spectator slots taken, but master slot is open.
                        // Allow AT MOST ONE pending connection to prevent connection flooding.
                        if (pendingMasterWs_ != nullptr) {
                            std::cout << "[auth] Connection rejected: server is full (pending master authentication in progress)\n";
                            ws->send("auth:error?reason=" + nbody_auth::urlEncode("Server is full. A Master login attempt is in progress."), uWS::OpCode::TEXT);
                            ws->end(1008, "Server is full (max 6 spectators)");
                            return;
                        }
                        data->isPending = true;
                        pendingMasterWs_ = ws;
                        std::cout << "[ws] client (" << data->clientIp << ") connected as unauthenticated pending (master slot available)\n";
                        // Notice: Do NOT subscribe to "frames" stream until authenticated!
                    }

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

                    // Handle ping / heartbeat to keep connection alive across proxies and VPNs
                    if (message == "ping" || message == "control:ping") {
                        ws->send("pong", uWS::OpCode::TEXT);
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

                        std::string clientIp = data->clientIp.empty() ? std::string(ws->getRemoteAddressAsText()) : data->clientIp;

                        // Reject login if a Master session is already active
                        if (currentMasterWs_ != nullptr && currentMasterWs_ != ws) {
                            std::cout << "[auth] Rejected master login from " << clientIp
                                      << ": Master session already active (" << masterName_ << ")\n";
                            ws->send("auth:error?reason=" + nbody_auth::urlEncode("A Master session is already active. Only one Master is permitted."), uWS::OpCode::TEXT);
                            sendAuthState(ws);
                            return;
                        }

                        if (masterPassword_.empty()) {
                            std::cout << "[auth] Rejected master login: SIM_MASTER_PASSWORD is not configured on server.\n";
                            ws->send("auth:error?reason=" + nbody_auth::urlEncode("Master authentication is disabled on this server."), uWS::OpCode::TEXT);
                            return;
                        }

                        if (quotaManager_) {
                            auto verifyRes = quotaManager_->verifyAndRecordLogin(password, masterPassword_, clientIp);
                            if (!verifyRes.allowed) {
                                std::cout << "[auth] Failed master login attempt from " << clientIp << ": " << verifyRes.errorMessage << "\n";
                                ws->send("auth:error?reason=" + nbody_auth::urlEncode(verifyRes.errorMessage), uWS::OpCode::TEXT);
                                broadcastAuthState();
                                return;
                            }
                        } else {
                            if (!ComputeQuotaManager::constantTimeCompare(password, masterPassword_)) {
                                std::cout << "[auth] Failed master login attempt with invalid password from " << clientIp << "\n";
                                ws->send("auth:error?reason=" + nbody_auth::urlEncode("Incorrect master password"), uWS::OpCode::TEXT);
                                return;
                            }
                        }

                        // Successfully promote to Master
                        activeSpectators_.erase(ws);
                        if (pendingMasterWs_ == ws) {
                            pendingMasterWs_ = nullptr;
                        }
                        data->isPending = false;
                        data->isSpectator = false;
                        data->isMaster = true;
                        data->clientName = name;
                        currentMasterWs_ = ws;
                        masterName_ = name;

                        ws->subscribe("frames");

                        std::cout << "[auth] Client authenticated as Master: " << masterName_ << " (" << clientIp << ")\n";
                        nbody_auth::touchActivityFile();
                        ws->send("auth:ok?role=master&masterName=" + nbody_auth::urlEncode(masterName_), uWS::OpCode::TEXT);
                        broadcastAuthState();
                        return;
                    }

                    if (message == "auth:logout") {
                        if (data->isMaster || currentMasterWs_ == ws) {
                            std::cout << "[auth] Master logged out: " << masterName_ << "\n";
                            data->isMaster = false;
                            currentMasterWs_ = nullptr;
                            masterName_ = "";

                            if (onMasterDisconnected_) {
                                onMasterDisconnected_();
                            }

                            if (activeSpectators_.size() < MAX_SPECTATORS) {
                                data->isSpectator = true;
                                activeSpectators_.insert(ws);
                            } else {
                                ws->unsubscribe("frames");
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

                    // Real master control input: mark activity so auto-shutdown timer is extended
                    nbody_auth::touchActivityFile();

                    if (onTextMessage_) {
                        onTextMessage_(message);
                    }
                },
                .close = [this, broadcastAuthState](auto* ws, int /*code*/, std::string_view /*message*/) {
                    auto* data = ws->getUserData();
                    activeSpectators_.erase(ws);
                    if (pendingMasterWs_ == ws) {
                        pendingMasterWs_ = nullptr;
                    }

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
                        data->isMaster = false;
                        if (onMasterDisconnected_) {
                            onMasterDisconnected_();
                        }
                        broadcastAuthState();
                    } else {
                        std::cout << "[ws] Spectator disconnected. Total spectators: "
                                  << activeSpectators_.size() << "/" << MAX_SPECTATORS << "\n";
                        broadcastAuthState();
                    }
                }
            }).listen(locallyHosted_ ? "0.0.0.0" : "127.0.0.1", port, [this, port](us_listen_socket_t* token) {
                if (token) {
                    listenSocket_ = token;
                    std::cout << "WebSocket server listening on "
                              << (locallyHosted_ ? "0.0.0.0" : "127.0.0.1") << ":" << port << " (uWebSockets)\n";
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

    void clearFrames() {
        std::lock_guard<std::mutex> lock(frameMutex_);
        latestFrame_.reset();
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
    void* pendingMasterWs_ = nullptr;
    std::string masterName_;
    std::unordered_set<void*> activeSpectators_;

    std::mutex frameMutex_;
    std::shared_ptr<std::vector<uint8_t>> latestFrame_;
    std::mutex scenarioTitleMutex_;
    std::string scenarioTitle_ = "Galaxy";
    std::atomic<bool> stopped_{false};
};
