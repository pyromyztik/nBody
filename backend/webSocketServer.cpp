#include "webSocketServer.hpp"

#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <iostream>

FrameBroadcaster::FrameBroadcaster(
        boost::asio::io_context& ioc,
        unsigned short port,
        TextMessageHandler onTextMessage,
        InitialTextMessageProvider initialTextMessageProvider
    ): ioc_(ioc), acceptor_(ioc), onTextMessage_(move(onTextMessage)),
       initialTextMessageProvider_(move(initialTextMessageProvider)) {
    boost::beast::error_code ec;

    const auto openEndpoint = [&](tcp::endpoint ep) {
        acceptor_.open(ep.protocol(), ec);
        if (ec) {
            cerr << "WebSocket acceptor open error: " << ec.message() << "\n";
            return false;
        }

        acceptor_.set_option(boost::asio::socket_base::reuse_address(true), ec);
        if (ec) {
            cerr << "WebSocket set_option reuse_address error: " << ec.message() << "\n";
            return false;
        }

        if (ep.protocol() == tcp::v6()) {
            // Allow dual-stack (IPv4-mapped) so ws://localhost works whether it resolves to 127.0.0.1 or ::1
            acceptor_.set_option(boost::asio::ip::v6_only(false), ec);
            if (ec) {
                cerr << "WebSocket set_option v6_only error: " << ec.message() << "\n";
            }
        }

        acceptor_.bind(ep, ec);
        if (ec) {
            cerr << "WebSocket bind error: " << ec.message() << "\n";
            return false;
        }

        acceptor_.listen(boost::asio::socket_base::max_listen_connections, ec);
        if (ec) {
            cerr << "WebSocket listen error: " << ec.message() << "\n";
            return false;
        }
        return true;
    };

    // Prefer IPv4 (most dev browsers connect via 127.0.0.1). If it fails (already bound or disabled), try dual-stack IPv6.
    if (!openEndpoint(tcp::endpoint(tcp::v4(), port))) {
        acceptor_.close();
        ec.clear();
        cerr << "Retrying dual-stack IPv6 bind for WebSocket on port " << port << "...\n";
        if (!openEndpoint(tcp::endpoint(tcp::v6(), port))) {
            cerr << "WebSocket listener failed to start; frames will not stream.\n";
            return;
        }
    }

    cout << "WebSocket server listening on port " << port << "\n";

    doAccept();
}

void FrameBroadcaster::stop() {
    boost::beast::error_code ec;
    acceptor_.close(ec);
}

void FrameBroadcaster::broadcast(const shared_ptr<vector<uint8_t>>& payload) {
    lock_guard<mutex> lock(sessionsMutex_);
    vector<shared_ptr<Session>> stillAlive;
    stillAlive.reserve(sessions_.size());

    for (auto& session : sessions_) {
        if (session->isOpen()) {
            session->sendBinary(payload);
            stillAlive.push_back(session);
        }
    }
    sessions_.swap(stillAlive);
}

void FrameBroadcaster::broadcastText(const string& message) {
    const auto payload = make_shared<string>(message);

    lock_guard<mutex> lock(sessionsMutex_);
    vector<shared_ptr<Session>> stillAlive;
    stillAlive.reserve(sessions_.size());

    for (auto& session : sessions_) {
        if (session->isOpen()) {
            session->sendText(payload);
            stillAlive.push_back(session);
        }
    }
    sessions_.swap(stillAlive);
}

void FrameBroadcaster::registerSession(const shared_ptr<Session>& session) {
    lock_guard<mutex> lock(sessionsMutex_);
    sessions_.push_back(session);
}

void FrameBroadcaster::handleTextMessage(const string& payload) {
    if (onTextMessage_) onTextMessage_(payload);
}

string FrameBroadcaster::makeInitialTextMessage() const {
    if (!initialTextMessageProvider_) return {};
    return initialTextMessageProvider_();
}

void FrameBroadcaster::doAccept() {
    acceptor_.async_accept(
        boost::asio::make_strand(ioc_),
        [this](boost::beast::error_code ec, tcp::socket socket) {
            if (!ec) {
                auto session = make_shared<Session>(move(socket), *this);
                session->run();
            } else if (ec != boost::asio::error::operation_aborted) {
                cerr << "WebSocket accept error: " << ec.message() << "\n";
            }
            doAccept();
        });
}

FrameBroadcaster::Session::Session(tcp::socket socket, FrameBroadcaster& owner)
    : ws_(move(socket)), owner_(owner) {}

bool FrameBroadcaster::Session::isOpen() const {
    return ws_.is_open();
}

void FrameBroadcaster::Session::run() {
    ws_.set_option(boost::beast::websocket::stream_base::timeout::suggested(
        boost::beast::role_type::server));
    ws_.set_option(boost::beast::websocket::stream_base::decorator(
        [](boost::beast::websocket::response_type& res) {
            res.set(boost::beast::http::field::server, string("nbody-ws"));
        }));

    ws_.async_accept(
        [self = shared_from_this()](boost::beast::error_code ec) { self->onAccept(ec); });
}

void FrameBroadcaster::Session::onAccept(boost::beast::error_code ec) {
    if (ec) {
        cerr << "WebSocket accept handshake failed: " << ec.message() << "\n";
        return;
    }
    cout << "WebSocket client connected\n";
    owner_.registerSession(shared_from_this());
    const string initialMessage = owner_.makeInitialTextMessage();
    if (!initialMessage.empty())
        sendText(make_shared<string>(initialMessage));
    doRead();
}

void FrameBroadcaster::Session::sendBinary(const shared_ptr<vector<uint8_t>>& payload) {
    boost::asio::dispatch(ws_.get_executor(), [self = shared_from_this(), payload]() {
        const bool writing = !self->queue_.empty();
        self->queue_.push_back(OutboundMessage{true, payload, {}});
        if (!writing) self->doWrite();
    });
}

void FrameBroadcaster::Session::sendText(const shared_ptr<string>& payload) {
    boost::asio::dispatch(ws_.get_executor(), [self = shared_from_this(), payload]() {
        const bool writing = !self->queue_.empty();
        self->queue_.push_back(OutboundMessage{false, {}, payload});
        if (!writing) self->doWrite();
    });
}

void FrameBroadcaster::Session::doRead() {
    ws_.async_read(
        readBuffer_,
        [self = shared_from_this()](boost::beast::error_code ec, size_t bytesTransferred) {
            self->onRead(ec, bytesTransferred);
        });
}

void FrameBroadcaster::Session::onRead(boost::beast::error_code ec, size_t) {
    if (ec == boost::beast::websocket::error::closed) return;

    if (ec) {
        cerr << "WebSocket read error: " << ec.message() << "\n";
        return;
    }

    if (ws_.got_text()) {
        const string payload = boost::beast::buffers_to_string(readBuffer_.data());
        owner_.handleTextMessage(payload);
    }

    readBuffer_.consume(readBuffer_.size());
    doRead();
}

void FrameBroadcaster::Session::doWrite() {
    const OutboundMessage& msg = queue_.front();
    ws_.binary(msg.binary);

    if (msg.binary) {
        ws_.async_write(
            boost::asio::buffer(*msg.binaryPayload),
            [self = shared_from_this()](boost::beast::error_code ec, size_t bytesTransferred) {
                self->onWrite(ec, bytesTransferred);
            });
        return;
    }

    ws_.async_write(
        boost::asio::buffer(*msg.textPayload),
        [self = shared_from_this()](boost::beast::error_code ec, size_t bytesTransferred) {
            self->onWrite(ec, bytesTransferred);
        });
}

void FrameBroadcaster::Session::onWrite(boost::beast::error_code ec, size_t) {
    if (ec) {
        cerr << "WebSocket write error: " << ec.message() << "\n";
        queue_.clear();
        return;
    }

    queue_.pop_front();
    if (!queue_.empty()) doWrite();
}
