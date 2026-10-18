#pragma once

#include <App.h>
#include <atomic>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

class FrameBroadcaster {
public:
    using TextMessageHandler = std::function<void(const std::string&)>;
    using InitialTextMessageProvider = std::function<std::string()>;

    FrameBroadcaster(
        unsigned short port,
        TextMessageHandler onTextMessage = {},
        InitialTextMessageProvider initialTextMessageProvider = {}
    ) : onTextMessage_(std::move(onTextMessage)),
        initialTextMessageProvider_(std::move(initialTextMessageProvider)) {

        serverThread_ = std::thread([this, port]() {
            struct PerSocketData {};

            uWS::App app;
            app_ = &app;
            loop_ = uWS::Loop::get();

            app.template ws<PerSocketData>("/*", {
                .compression = uWS::DISABLED,
                .maxPayloadLength = 64 * 1024,
                .idleTimeout = 120,
                .maxBackpressure = 64 * 1024 * 1024,
                .open = [this](auto* ws) {
                    std::cout << "[ws] client connected\n";
                    ws->subscribe("frames");
                    if (initialTextMessageProvider_) {
                        std::string initMsg = initialTextMessageProvider_();
                        if (!initMsg.empty()) {
                            ws->send(initMsg, uWS::OpCode::TEXT);
                        }
                    }
                },
                .message = [this](auto* /*ws*/, std::string_view message, uWS::OpCode opCode) {
                    if (opCode == uWS::OpCode::TEXT && onTextMessage_) {
                        onTextMessage_(std::string(message));
                    }
                },
                .close = [](auto* /*ws*/, int /*code*/, std::string_view /*message*/) {
                    std::cout << "[ws] client disconnected\n";
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
    TextMessageHandler onTextMessage_;
    InitialTextMessageProvider initialTextMessageProvider_;
    std::promise<void> readyPromise_;
    std::thread serverThread_;
    uWS::App* app_ = nullptr;
    uWS::Loop* loop_ = nullptr;
    us_listen_socket_t* listenSocket_ = nullptr;

    std::mutex frameMutex_;
    std::shared_ptr<std::vector<uint8_t>> latestFrame_;
    std::atomic<bool> stopped_{false};
};
