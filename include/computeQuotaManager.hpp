#pragma once

#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>

class ComputeQuotaManager {
public:
    static constexpr double DEFAULT_DAILY_COMPUTE_LIMIT_SECONDS = 3600.0; // 1.0 hour
    static constexpr int MAX_PASSWORD_ATTEMPTS = 5;
    static constexpr int MIN_ATTEMPT_INTERVAL_MS = 500;

    explicit ComputeQuotaManager(const std::string& persistenceFilePath = "compute_quota.dat")
        : persistenceFilePath_(persistenceFilePath) {
        
        const char* envLimit = std::getenv("SIM_DAILY_COMPUTE_LIMIT_SECONDS");
        if (envLimit && envLimit[0] != '\0') {
            try {
                double parsed = std::stod(envLimit);
                if (parsed > 0.0) {
                    maxComputeSeconds_ = parsed;
                }
            } catch (...) {}
        }

        currentDate_ = getTodayDateString();
        loadFromFile();
        checkDateRolloverLocked();
        saveToFileLocked();

        std::cout << "[quota] Initialized daily compute limit: " << maxComputeSeconds_
                  << "s (used today: " << usedComputeSeconds_ << "s, date: " << currentDate_
                  << ", failed attempts: " << failedLoginAttempts_ << ")\n";
    }

    ~ComputeQuotaManager() {
        std::lock_guard<std::mutex> lock(mutex_);
        saveToFileLocked();
    }

    // Call while physics ticks are executing. Returns true if quota is now exhausted.
    bool addComputeSeconds(double seconds) {
        if (seconds <= 0.0) return isComputeExhausted();

        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();

        if (usedComputeSeconds_ >= maxComputeSeconds_) {
            return true;
        }

        usedComputeSeconds_ += seconds;
        if (usedComputeSeconds_ >= maxComputeSeconds_) {
            usedComputeSeconds_ = maxComputeSeconds_;
            saveToFileLocked();
            return true;
        }

        // Periodic flush to disk every ~5 compute seconds
        if (usedComputeSeconds_ - lastSavedComputeSeconds_ >= 5.0) {
            saveToFileLocked();
        }

        return false;
    }

    bool isComputeExhausted() {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();
        return usedComputeSeconds_ >= maxComputeSeconds_;
    }

    double getUsedComputeSeconds() {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();
        return usedComputeSeconds_;
    }

    double getMaxComputeSeconds() const {
        return maxComputeSeconds_;
    }

    double getRemainingComputeSeconds() {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();
        return std::max(0.0, maxComputeSeconds_ - usedComputeSeconds_);
    }

    bool canSimulate() {
        return !isComputeExhausted();
    }

    struct LoginVerificationResult {
        bool allowed = false;
        bool rateLimited = false;
        bool lockedOut = false;
        int remainingAttempts = 0;
        std::string errorMessage;
    };

    LoginVerificationResult verifyAndRecordLogin(
        const std::string& inputPassword,
        const std::string& expectedPassword,
        const std::string& clientIp
    ) {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();

        LoginVerificationResult result;
        const auto now = std::chrono::steady_clock::now();

        // 1. Rate limiting check per IP/socket
        auto itLastTime = lastAttemptTimeByIp_.find(clientIp);
        if (itLastTime != lastAttemptTimeByIp_.end()) {
            auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - itLastTime->second).count();
            if (elapsedMs < MIN_ATTEMPT_INTERVAL_MS) {
                result.rateLimited = true;
                result.errorMessage = "Rate limit exceeded. Please wait a moment between attempts.";
                result.remainingAttempts = std::max(0, MAX_PASSWORD_ATTEMPTS - failedLoginAttempts_);
                return result;
            }
        }
        lastAttemptTimeByIp_[clientIp] = now;

        // 2. Check if already locked out for the day
        if (failedLoginAttempts_ >= MAX_PASSWORD_ATTEMPTS || lockedOutIPs_.count(clientIp) > 0) {
            result.lockedOut = true;
            result.remainingAttempts = 0;
            result.errorMessage = "Maximum password attempts exceeded. Master login is locked out for the day. Please return tomorrow.";
            return result;
        }

        // 3. Reject oversized input
        if (inputPassword.size() > 128) {
            result.errorMessage = "Password length exceeds maximum allowed limit.";
            result.remainingAttempts = std::max(0, MAX_PASSWORD_ATTEMPTS - failedLoginAttempts_);
            return result;
        }

        // 4. Verify password
        if (inputPassword == expectedPassword) {
            result.allowed = true;
            result.remainingAttempts = std::max(0, MAX_PASSWORD_ATTEMPTS - failedLoginAttempts_);
            return result;
        }

        // 5. Record failed attempt
        failedLoginAttempts_++;
        ipFailedAttempts_[clientIp]++;

        if (failedLoginAttempts_ >= MAX_PASSWORD_ATTEMPTS || ipFailedAttempts_[clientIp] >= MAX_PASSWORD_ATTEMPTS) {
            lockedOutIPs_.insert(clientIp);
            saveToFileLocked();
            result.lockedOut = true;
            result.remainingAttempts = 0;
            result.errorMessage = "Maximum password attempts exceeded. Master login is locked out for the day. Please return tomorrow.";
            std::cout << "[auth] Max login attempts exceeded (" << failedLoginAttempts_
                      << "). Locking out master authentication for the day (" << currentDate_ << ").\n";
            return result;
        }

        saveToFileLocked();
        result.remainingAttempts = std::max(0, MAX_PASSWORD_ATTEMPTS - failedLoginAttempts_);
        std::ostringstream ss;
        ss << "Incorrect master password. " << result.remainingAttempts << " attempt(s) remaining.";
        result.errorMessage = ss.str();
        return result;
    }

    bool isLoginLocked(const std::string& clientIp = "") {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();
        if (failedLoginAttempts_ >= MAX_PASSWORD_ATTEMPTS) {
            return true;
        }
        if (!clientIp.empty() && lockedOutIPs_.count(clientIp) > 0) {
            return true;
        }
        return false;
    }

    int getRemainingLoginAttempts(const std::string& clientIp = "") {
        std::lock_guard<std::mutex> lock(mutex_);
        checkDateRolloverLocked();
        int remaining = std::max(0, MAX_PASSWORD_ATTEMPTS - failedLoginAttempts_);
        if (!clientIp.empty()) {
            auto it = ipFailedAttempts_.find(clientIp);
            if (it != ipFailedAttempts_.end()) {
                remaining = std::min(remaining, std::max(0, MAX_PASSWORD_ATTEMPTS - it->second));
            }
        }
        return remaining;
    }

    void resetQuotaAndAttempts() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::cout << "[quota] Resetting tracked compute usage (was " << usedComputeSeconds_
                  << "s) and failed password attempts (was " << failedLoginAttempts_ << " attempts, "
                  << lockedOutIPs_.size() << " locked IP(s)).\n";
        currentDate_ = getTodayDateString();
        usedComputeSeconds_ = 0.0;
        lastSavedComputeSeconds_ = 0.0;
        failedLoginAttempts_ = 0;
        ipFailedAttempts_.clear();
        lastAttemptTimeByIp_.clear();
        lockedOutIPs_.clear();
        saveToFileLocked();
        std::cout << "[quota] Reset complete. Saved fresh zeroed state to " << persistenceFilePath_ << ".\n";
    }

private:
    static std::string getTodayDateString() {
        std::time_t t = std::time(nullptr);
        std::tm tm_buf{};
#if defined(_WIN32)
        localtime_s(&tm_buf, &t);
#else
        localtime_r(&t, &tm_buf);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm_buf, "%Y-%m-%d");
        return oss.str();
    }

    void checkDateRolloverLocked() {
        std::string today = getTodayDateString();
        if (today != currentDate_) {
            std::cout << "[quota] Calendar day rollover detected: " << currentDate_ << " -> " << today << ". Resetting daily quota & login attempts.\n";
            currentDate_ = today;
            usedComputeSeconds_ = 0.0;
            lastSavedComputeSeconds_ = 0.0;
            failedLoginAttempts_ = 0;
            ipFailedAttempts_.clear();
            lockedOutIPs_.clear();
            saveToFileLocked();
        }
    }

    void saveToFileLocked() {
        std::ofstream ofs(persistenceFilePath_, std::ios::trunc);
        if (!ofs.is_open()) {
            std::cerr << "[quota] Failed to open persistence file for writing: " << persistenceFilePath_ << "\n";
            return;
        }

        ofs << "date=" << currentDate_ << "\n";
        ofs << "used_compute=" << std::fixed << std::setprecision(3) << usedComputeSeconds_ << "\n";
        ofs << "failed_attempts=" << failedLoginAttempts_ << "\n";
        
        ofs << "locked_ips=";
        bool first = true;
        for (const auto& ip : lockedOutIPs_) {
            if (!first) ofs << ",";
            ofs << ip;
            first = false;
        }
        ofs << "\n";

        lastSavedComputeSeconds_ = usedComputeSeconds_;
    }

    void loadFromFile() {
        std::ifstream ifs(persistenceFilePath_);
        if (!ifs.is_open()) {
            return; // Fresh start
        }

        std::string line;
        std::string fileDate;
        double fileUsedCompute = 0.0;
        int fileFailedAttempts = 0;
        std::unordered_set<std::string> fileLockedIps;

        while (std::getline(ifs, line)) {
            size_t eq = line.find('=');
            if (eq == std::string::npos) continue;
            std::string key = line.substr(0, eq);
            std::string val = line.substr(eq + 1);

            if (key == "date") {
                fileDate = val;
            } else if (key == "used_compute") {
                try { fileUsedCompute = std::stod(val); } catch (...) {}
            } else if (key == "failed_attempts") {
                try { fileFailedAttempts = std::stoi(val); } catch (...) {}
            } else if (key == "locked_ips") {
                size_t start = 0;
                while (start < val.size()) {
                    size_t comma = val.find(',', start);
                    std::string ip = val.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
                    if (!ip.empty()) fileLockedIps.insert(ip);
                    if (comma == std::string::npos) break;
                    start = comma + 1;
                }
            }
        }

        std::string today = getTodayDateString();
        if (fileDate == today) {
            usedComputeSeconds_ = std::min(maxComputeSeconds_, std::max(0.0, fileUsedCompute));
            failedLoginAttempts_ = std::min(MAX_PASSWORD_ATTEMPTS, std::max(0, fileFailedAttempts));
            lockedOutIPs_ = std::move(fileLockedIps);
            lastSavedComputeSeconds_ = usedComputeSeconds_;
            std::cout << "[quota] Loaded saved daily quota state for " << today
                      << ": used " << usedComputeSeconds_ << "s, "
                      << failedLoginAttempts_ << " failed attempts\n";
        } else {
            std::cout << "[quota] Saved quota is from previous day (" << fileDate
                      << "). Starting fresh for today (" << today << ").\n";
            currentDate_ = today;
            usedComputeSeconds_ = 0.0;
            failedLoginAttempts_ = 0;
            lockedOutIPs_.clear();
        }
    }

    std::mutex mutex_;
    std::string persistenceFilePath_;
    std::string currentDate_;
    double maxComputeSeconds_ = DEFAULT_DAILY_COMPUTE_LIMIT_SECONDS;
    double usedComputeSeconds_ = 0.0;
    double lastSavedComputeSeconds_ = 0.0;
    int failedLoginAttempts_ = 0;
    std::unordered_map<std::string, int> ipFailedAttempts_;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> lastAttemptTimeByIp_;
    std::unordered_set<std::string> lockedOutIPs_;
};

