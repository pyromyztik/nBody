#pragma once

#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using namespace std;

class FrameBroadcaster {
    public:
    using TextMessageHandler = function<void(const string&)>;
    using InitialTextMessageProvider = function<string()>;

    FrameBroadcaster(
        boost::asio::io_context& ioc,
        unsigned short port,
        TextMessageHandler onTextMessage = {},
        InitialTextMessageProvider initialTextMessageProvider = {});

    void broadcast(const shared_ptr<vector<uint8_t>>& payload);
    void broadcastText(const string& message);
    void stop();

    private:
    using tcp = boost::asio::ip::tcp;
    using websocket = boost::beast::websocket::stream<tcp::socket>;

    struct OutboundMessage {
        bool binary = false;
        shared_ptr<vector<uint8_t>> binaryPayload;
        shared_ptr<string> textPayload;
    };

    struct Session : public enable_shared_from_this<Session> {
        explicit Session(tcp::socket socket, FrameBroadcaster& owner);
        void run();
        void sendBinary(const shared_ptr<vector<uint8_t>>& payload);
        void sendText(const shared_ptr<string>& payload);
        bool isOpen() const;

        private:
        void onAccept(boost::beast::error_code ec);
        void doRead();
        void onRead(boost::beast::error_code ec, size_t bytesTransferred);
        void doWrite();
        void onWrite(boost::beast::error_code ec, size_t bytesTransferred);

        websocket ws_;
        FrameBroadcaster& owner_;
        boost::beast::flat_buffer readBuffer_;
        deque<OutboundMessage> queue_;
    };

    void registerSession(const shared_ptr<Session>& session);
    void handleTextMessage(const string& payload);
    string makeInitialTextMessage() const;

    void doAccept();

    boost::asio::io_context& ioc_;
    tcp::acceptor acceptor_;
    TextMessageHandler onTextMessage_;
    InitialTextMessageProvider initialTextMessageProvider_;
    mutex sessionsMutex_;
    vector<shared_ptr<Session>> sessions_;
};
