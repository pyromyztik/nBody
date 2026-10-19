#include "scenarios.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <optional>
#include <sstream>
#include <unordered_set>
#include <vector>

namespace {
    // Binary format:
    // [u32 magic='AGM1'][u32 count][count * (10 x f32)]
    // per body fields: x y z vx vy vz fx fy fz mass
    constexpr uint32_t AGAMA_SNAPSHOT_MAGIC = 0x314D4741u;

    struct AgamaBodyRecord {
        float x;
        float y;
        float z;
        float vx;
        float vy;
        float vz;
        float fx;
        float fy;
        float fz;
        float mass;
    };

    constexpr size_t MIN_ORBIT_BODIES = 2;
    constexpr size_t MAX_SCENARIO_BODIES = 1000000;
    constexpr double MIN_ACCRETION_DISK_RADIUS = 0.0;

    constexpr const char* GALAXY_SNAPSHOT_PATH = "scenarios/galaxy.bin";
    constexpr const char* GALAXY_COLLISION_SNAPSHOT_PATH = "scenarios/galaxyCollision.bin";
    constexpr const char* GENERATED_SCENARIO_PATH = "scenarios/scenario.bin";
    constexpr const char* STABLE_ORBITS_SCRIPT = "scenarios/generateStableOrbits.py";
    constexpr const char* ACCRETION_DISK_SCRIPT = "scenarios/generateAccretionDisk.py";

    const unordered_set<string> STABLE_ORBIT_FAMILIES = {
        "auto",
        "polygon",
        "multiring",
        "wheel",
        "hierarchical",
        "bhh",
        "suvakov-dmitrasinovic",
        "retrograde",
        "interplay",
        "figure8",
        "lagrange-3",
        "euler-3",
    };

    const vector<string> STABLE_ORBIT_FAMILY_ORDER = {
        "auto",
        "polygon",
        "multiring",
        "wheel",
        "hierarchical",
        "bhh",
        "suvakov-dmitrasinovic",
        "retrograde",
        "interplay",
        "figure8",
        "lagrange-3",
        "euler-3",
    };

    string trim(string value) {
        const auto isWhitespace = [](unsigned char ch) { return isspace(ch) != 0; };

        value.erase(
            value.begin(),
            find_if(value.begin(), value.end(), [&](unsigned char ch) { return !isWhitespace(ch); })
        );

        value.erase(
            find_if(value.rbegin(), value.rend(), [&](unsigned char ch) { return !isWhitespace(ch); })
                .base(),
            value.end()
        );

        return value;
    }

    string toLower(string value) {
        transform(
            value.begin(),
            value.end(),
            value.begin(),
            [](unsigned char ch) { return static_cast<char>(tolower(ch)); }
        );
        return value;
    }

    bool readTrimmedLine(istream& input, string& line) {
        if (!getline(input, line)) return false;
        line = trim(line);
        return true;
    }

    optional<size_t> parseSizeValue(const string& text) {
        if (text.empty()) return nullopt;

        try {
            size_t parsedChars = 0;
            const unsigned long long parsed = stoull(text, &parsedChars, 10);
            if (parsedChars != text.size()) return nullopt;
            if (parsed > static_cast<unsigned long long>(numeric_limits<size_t>::max()))
                return nullopt;
            return static_cast<size_t>(parsed);
        } catch (...) {
            return nullopt;
        }
    }

    optional<double> parseDoubleValue(const string& text) {
        if (text.empty()) return nullopt;

        try {
            size_t parsedChars = 0;
            const double parsed = stod(text, &parsedChars);
            if (parsedChars != text.size() || !isfinite(parsed))
                return nullopt;
            return parsed;
        } catch (...) {
            return nullopt;
        }
    }

    optional<unsigned char> parseHexNibble(char ch) {
        if (ch >= '0' && ch <= '9') return static_cast<unsigned char>(ch - '0');
        if (ch >= 'a' && ch <= 'f') return static_cast<unsigned char>(10 + ch - 'a');
        if (ch >= 'A' && ch <= 'F') return static_cast<unsigned char>(10 + ch - 'A');
        return nullopt;
    }

    optional<string> decodeUrlComponent(const string& encoded) {
        string decoded;
        decoded.reserve(encoded.size());

        for (size_t i = 0; i < encoded.size(); ++i) {
            const char ch = encoded[i];
            if (ch == '+') {
                decoded.push_back(' ');
                continue;
            }

            if (ch != '%') {
                decoded.push_back(ch);
                continue;
            }

            if (i + 2 >= encoded.size()) return nullopt;

            optional<unsigned char> hi = parseHexNibble(encoded[i + 1]);
            optional<unsigned char> lo = parseHexNibble(encoded[i + 2]);
            if (!hi.has_value() || !lo.has_value()) return nullopt;

            decoded.push_back(static_cast<char>((*hi << 4) | *lo));
            i += 2;
        }

        return decoded;
    }

    string canonicalStableFamily(string value) {
        value = toLower(trim(value));
        for (char& ch : value) {
            if (ch == '_' || ch == ' ') ch = '-';
        }

        if (value == "figure-8") value = "figure8";
        if (value == "lagrange3") value = "lagrange-3";
        if (value == "euler3") value = "euler-3";
        return value;
    }

    optional<string> validateStableOrbitBodyCount(const string& family, size_t bodyCount) {
        if (family == "lagrange-3" || family == "euler-3") {
            if (bodyCount != 3) {
                return "Family " + family + " requires exactly 3 bodies.";
            }
            return nullopt;
        }

        size_t minBodies = MIN_ORBIT_BODIES;
        if (family == "multiring") {
            minBodies = 4;
        } else if (family == "wheel"
                || family == "hierarchical"
                || family == "retrograde"
                || family == "interplay"
                || family == "figure8"
                || family == "bhh"
                || family == "suvakov-dmitrasinovic") {
            minBodies = 3;
        }

        if (bodyCount < minBodies)
            return "Family " + family + " requires at least " + to_string(minBodies) + " bodies.";

        return nullopt;
    }

    optional<ScenarioKind> parseScenarioChoice(const string& inputChoice) {
        const string choice = toLower(trim(inputChoice));

        if (choice == "1" || choice == "galaxy")
            return ScenarioKind::Galaxy;
        if (choice == "2" || choice == "galaxy-collision" || choice == "galaxycollision")
            return ScenarioKind::GalaxyCollision;
        if (choice == "3" || choice == "stable-orbits" || choice == "stableorbits")
            return ScenarioKind::StableOrbits;
        if (choice == "4" || choice == "accretion-disk" || choice == "accretiondisk")
            return ScenarioKind::AccretionDisk;
        return nullopt;
    }

    bool promptBodyCount(istream& input,
                         ostream& output,
                         const string& label,
                         size_t minBodies,
                         size_t& outBodyCount) {
        while (true) {
            output << label;
            string line;
            if (!readTrimmedLine(input, line)) return false;

            optional<size_t> parsed = parseSizeValue(line);
            if (!parsed.has_value()) {
                output << "Invalid body count: enter a positive integer.\n";
                continue;
            }

            if (*parsed < minBodies || *parsed > MAX_SCENARIO_BODIES) {
                output << "Body count must be between " << minBodies
                       << " and " << MAX_SCENARIO_BODIES << ".\n";
                continue;
            }

            outBodyCount = *parsed;
            return true;
        }
    }

    bool promptPositiveDouble(istream& input,
                              ostream& output,
                              const string& label,
                              double& outValue) {
        while (true) {
            output << label;
            string line;
            if (!readTrimmedLine(input, line)) return false;

            optional<double> parsed = parseDoubleValue(line);
            if (!parsed.has_value()) {
                output << "Invalid value: enter a numeric value.\n";
                continue;
            }

            if (!(*parsed > MIN_ACCRETION_DISK_RADIUS)) {
                output << "Value must be greater than 0.\n";
                continue;
            }

            outValue = *parsed;
            return true;
        }
    }

    bool promptStableOrbitsFamily(istream& input, ostream& output, string& outFamily) {
        output << "Stable Orbit families:\n"
               << "  1) auto\n"
               << "  2) polygon\n"
               << "  3) multiring\n"
               << "  4) wheel\n"
               << "  5) hierarchical\n"
               << "  6) bhh\n"
               << "  7) suvakov-dmitrasinovic\n"
               << "  8) retrograde\n"
               << "  9) interplay\n"
               << "  10) figure8\n"
               << "  11) lagrange-3\n"
               << "  12) euler-3\n";

        while (true) {
            output << "Enter stable-orbit family (name or number): ";
            string rawFamily;
            if (!readTrimmedLine(input, rawFamily)) return false;

            optional<size_t> numericChoice = parseSizeValue(rawFamily);
            if (numericChoice.has_value()
             && *numericChoice >= 1
             && *numericChoice <= STABLE_ORBIT_FAMILY_ORDER.size()) {
                outFamily = STABLE_ORBIT_FAMILY_ORDER[*numericChoice - 1];
                return true;
            }

            const string canonical = canonicalStableFamily(rawFamily);
            if (STABLE_ORBIT_FAMILIES.count(canonical) == 0U) {
                output << "Invalid family. Use one of the listed family names.\n";
                continue;
            }

            outFamily = canonical;
            return true;
        }
    }

    bool promptStableOrbitBodyCount(istream& input,
                                    ostream& output,
                                    const string& family,
                                    size_t& outBodyCount) {
        while (true) {
            if (!promptBodyCount(
                    input,
                    output,
                    "Enter Stable Orbits body count: ",
                    MIN_ORBIT_BODIES,
                    outBodyCount)) {
                return false;
            }

            optional<string> compatibilityError = validateStableOrbitBodyCount(family, outBodyCount);
            if (compatibilityError.has_value()) {
                output << *compatibilityError << "\n";
                continue;
            }

            return true;
        }
    }

    bool isCommandNotFoundExitCode(int code) {
        return code == 127 || code == 9009;
    }

    bool runPythonScript(const string& scriptPath,
                         const vector<string>& args,
                         ostream& output) {
        const vector<string> launchers = {"python", "py -3"};

        for (size_t i = 0; i < launchers.size(); ++i) {
            ostringstream command;
            command << launchers[i] << " \"" << scriptPath << "\"";
            for (const string& arg : args)
                command << " " << arg;

            output << "Executing: " << command.str() << "\n";
            const int exitCode = system(command.str().c_str());
            if (exitCode == 0)
                return true;

            if (!isCommandNotFoundExitCode(exitCode)) {
                output << "Generator failed with exit code " << exitCode << ".\n";
                return false;
            }

            if (i + 1 < launchers.size())
                output << "Python launcher not found; trying fallback launcher...\n";
        }

        output << "Unable to run Python: no working Python launcher was found.\n";
        return false;
    }

    bool validateSelection(const ScenarioSelection& selection, ostream& output) {
        if (selection.kind == ScenarioKind::StableOrbits) {
            if (selection.bodyCount < MIN_ORBIT_BODIES || selection.bodyCount > MAX_SCENARIO_BODIES) {
                output << "Stable Orbits body count must be between "
                       << MIN_ORBIT_BODIES << " and " << MAX_SCENARIO_BODIES << ".\n";
                return false;
            }

            if (STABLE_ORBIT_FAMILIES.count(selection.stableFamily) == 0U) {
                output << "Stable Orbits family is invalid.\n";
                return false;
            }

            optional<string> compatibilityError =
                validateStableOrbitBodyCount(selection.stableFamily, selection.bodyCount);
            if (compatibilityError.has_value()) {
                output << *compatibilityError << "\n";
                return false;
            }

            return true;
        }

        if (selection.kind == ScenarioKind::AccretionDisk) {
            if (selection.bodyCount < MIN_ORBIT_BODIES || selection.bodyCount > MAX_SCENARIO_BODIES) {
                output << "Accretion Disk body count must be between "
                       << MIN_ORBIT_BODIES << " and " << MAX_SCENARIO_BODIES << ".\n";
                return false;
            }

            if (!(selection.accretionDiskMaxRadius > MIN_ACCRETION_DISK_RADIUS)) {
                output << "Accretion Disk radius must be greater than 0.\n";
                return false;
            }

            return true;
        }

        return true;
    }
}

bool promptScenarioSelection(ScenarioSelection& selection,
                             istream& input,
                             ostream& output) {
    while (true) {
        output << "Select a scenario to load:\n"
               << "  1) galaxy\n"
               << "  2) galaxy-collision\n"
               << "  3) stable-orbits\n"
               << "  4) accretion-disk\n"
               << "Enter selection: ";

        string rawChoice;
        if (!readTrimmedLine(input, rawChoice))
            return false;

        optional<ScenarioKind> scenario = parseScenarioChoice(rawChoice);
        if (!scenario.has_value()) {
            output << "Invalid scenario selection. Please try again.\n";
            continue;
        }

        selection = ScenarioSelection{};
        selection.kind = *scenario;

        if (selection.kind == ScenarioKind::StableOrbits) {
            if (!promptStableOrbitsFamily(input, output, selection.stableFamily))
                return false;

            if (!promptStableOrbitBodyCount(
                    input,
                    output,
                    selection.stableFamily,
                    selection.bodyCount)) {
                return false;
            }
        } else if (selection.kind == ScenarioKind::AccretionDisk) {
            if (!promptBodyCount(
                    input,
                    output,
                    "Enter Accretion Disk body count: ",
                    MIN_ORBIT_BODIES,
                    selection.bodyCount)) {
                return false;
            }

            if (!promptPositiveDouble(
                    input,
                    output,
                    "Enter Accretion Disk max radius: ",
                    selection.accretionDiskMaxRadius)) {
                return false;
            }
        }

        return true;
    }
}

bool parseScenarioStartMessage(const string& message,
                               ScenarioSelection& selection,
                               ostream* errorOutput) {
    constexpr const char* SCENARIO_PREFIX = "scenario:start?";
    const string prefix(SCENARIO_PREFIX);

    if (message.rfind(prefix, 0) != 0)
        return false;

    string kindToken;
    string stableFamilyToken;
    string bodyCountToken;
    string accretionDiskRadiusToken;

    const string query = message.substr(prefix.size());
    size_t start = 0;

    while (start <= query.size()) {
        const size_t end = query.find('&', start);
        const string pair = query.substr(start, end == string::npos ? string::npos : end - start);

        if (!pair.empty()) {
            const size_t equals = pair.find('=');
            const string encodedKey = pair.substr(0, equals);
            const string encodedValue = equals == string::npos ? string() : pair.substr(equals + 1);

            optional<string> decodedKey = decodeUrlComponent(encodedKey);
            optional<string> decodedValue = decodeUrlComponent(encodedValue);
            if (!decodedKey.has_value() || !decodedValue.has_value()) {
                if (errorOutput) *errorOutput << "Malformed URL-encoded scenario parameter.\n";
                return false;
            }

            if (*decodedKey == "kind") {
                kindToken = trim(*decodedValue);
            } else if (*decodedKey == "family") {
                stableFamilyToken = trim(*decodedValue);
            } else if (*decodedKey == "bodies") {
                bodyCountToken = trim(*decodedValue);
            } else if (*decodedKey == "radius") {
                accretionDiskRadiusToken = trim(*decodedValue);
            }
        }

        if (end == string::npos) break;
        start = end + 1;
    }

    optional<ScenarioKind> scenarioKind = parseScenarioChoice(kindToken);
    if (!scenarioKind.has_value()) {
        if (errorOutput) *errorOutput << "Scenario kind is missing or invalid.\n";
        return false;
    }

    ScenarioSelection parsedSelection;
    parsedSelection.kind = *scenarioKind;

    if (parsedSelection.kind == ScenarioKind::StableOrbits) {
        if (stableFamilyToken.empty()) {
            if (errorOutput) *errorOutput << "Stable Orbits requires a family parameter.\n";
            return false;
        }

        if (bodyCountToken.empty()) {
            if (errorOutput) *errorOutput << "Stable Orbits requires a bodies parameter.\n";
            return false;
        }

        parsedSelection.stableFamily = canonicalStableFamily(stableFamilyToken);
        optional<size_t> parsedBodyCount = parseSizeValue(bodyCountToken);
        if (!parsedBodyCount.has_value()) {
            if (errorOutput) *errorOutput << "Stable Orbits bodies parameter is invalid.\n";
            return false;
        }
        parsedSelection.bodyCount = *parsedBodyCount;
    }

    if (parsedSelection.kind == ScenarioKind::AccretionDisk) {
        if (bodyCountToken.empty()) {
            if (errorOutput) *errorOutput << "Accretion Disk requires a bodies parameter.\n";
            return false;
        }

        if (accretionDiskRadiusToken.empty()) {
            if (errorOutput) *errorOutput << "Accretion Disk requires a radius parameter.\n";
            return false;
        }

        optional<size_t> parsedBodyCount = parseSizeValue(bodyCountToken);
        if (!parsedBodyCount.has_value()) {
            if (errorOutput) *errorOutput << "Accretion Disk bodies parameter is invalid.\n";
            return false;
        }
        parsedSelection.bodyCount = *parsedBodyCount;

        optional<double> parsedRadius = parseDoubleValue(accretionDiskRadiusToken);
        if (!parsedRadius.has_value()) {
            if (errorOutput) *errorOutput << "Accretion Disk radius parameter is invalid.\n";
            return false;
        }
        parsedSelection.accretionDiskMaxRadius = *parsedRadius;
    }

    ostringstream validationErrors;
    if (!validateSelection(parsedSelection, validationErrors)) {
        if (errorOutput) *errorOutput << validationErrors.str();
        return false;
    }

    selection = parsedSelection;
    return true;
}

bool loadAgamaSnapshot(ParticleSystem& system, const string& filePath) {
    ifstream in(filePath, ios::binary);
    if(!in) return false;

    uint32_t magic = 0;
    uint32_t count = 0;
    in.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    in.read(reinterpret_cast<char*>(&count), sizeof(count));
    if(!in || magic != AGAMA_SNAPSHOT_MAGIC || count == 0) return false;

    vector<AgamaBodyRecord> records(static_cast<size_t>(count));
    in.read(
        reinterpret_cast<char*>(records.data()),
        static_cast<streamsize>(records.size() * sizeof(AgamaBodyRecord))
    );
    if(!in) return false;

    system.allocate(static_cast<size_t>(count));
    for(size_t i = 0; i < records.size(); ++i) {
        const AgamaBodyRecord& r = records[i];
        if (!(r.mass > 0.0f)) return false;

        system.setPosition(i, r.x, r.y, r.z);
        system.setVelocity(i, r.vx, r.vy, r.vz);
        system.setForce(i, r.fx, r.fy, r.fz);
        system.setMass(i, r.mass);
    }
    return true;
}

bool loadSelectedScenario(ParticleSystem& system,
                          const ScenarioSelection& selection,
                          ostream& output) {
    if (!validateSelection(selection, output))
        return false;

    switch (selection.kind) {
        case ScenarioKind::Galaxy:
            output << "Loading prebuilt scenario: " << GALAXY_SNAPSHOT_PATH << "\n";
            return loadAgamaSnapshot(system, GALAXY_SNAPSHOT_PATH);

        case ScenarioKind::GalaxyCollision:
            output << "Loading prebuilt scenario: " << GALAXY_COLLISION_SNAPSHOT_PATH << "\n";
            return loadAgamaSnapshot(system, GALAXY_COLLISION_SNAPSHOT_PATH);

        case ScenarioKind::StableOrbits: {
            const vector<string> args = {
                "--family", selection.stableFamily,
                "--bodies", to_string(selection.bodyCount),
                "--out", string("\"") + GENERATED_SCENARIO_PATH + "\"",
            };

            if (!runPythonScript(STABLE_ORBITS_SCRIPT, args, output))
                return false;

            output << "Loading generated scenario: " << GENERATED_SCENARIO_PATH << "\n";
            return loadAgamaSnapshot(system, GENERATED_SCENARIO_PATH);
        }

        case ScenarioKind::AccretionDisk: {
            const vector<string> args = {
                "--bodies", to_string(selection.bodyCount),
                "--radius", to_string(selection.accretionDiskMaxRadius),
                "--out", string("\"") + GENERATED_SCENARIO_PATH + "\"",
            };

            if (!runPythonScript(ACCRETION_DISK_SCRIPT, args, output))
                return false;

            output << "Loading generated scenario: " << GENERATED_SCENARIO_PATH << "\n";
            return loadAgamaSnapshot(system, GENERATED_SCENARIO_PATH);
        }
    }
    output << "Unsupported scenario selection.\n";
    return false;
}

