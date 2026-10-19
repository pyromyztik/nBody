#include "nBodySim.hpp"

#include <iosfwd>
#include <string>

using namespace std;

enum class ScenarioKind {
	Galaxy,
	GalaxyCollision,
	StableOrbits,
	AccretionDisk,
};

struct ScenarioSelection {
	ScenarioKind kind = ScenarioKind::Galaxy;
	size_t bodyCount = 0;
	string stableFamily;
	double accretionDiskMaxRadius = 0.0;
};

// Prompt for scenario selection and required runtime parameters.
// Returns false when input stream is closed before a complete selection is made.
bool promptScenarioSelection(ScenarioSelection& selection,
							 istream& input,
							 ostream& output);

// Parse a frontend websocket scenario-start message.
// Expected format: scenario:start?kind=<kind>[&family=<stable-family>][&bodies=<count>][&radius=<max-radius>]
// Returns true if the message is well-formed and passes scenario validation.
bool parseScenarioStartMessage(const string& message,
						   ScenarioSelection& selection,
						   ostream* errorOutput = nullptr);

// Load or generate the selected scenario and populate the simulation particle system.
// Returns true on success, false on validation/generation/load errors.
bool loadSelectedScenario(ParticleSystem& system,
						  const ScenarioSelection& selection,
						  ostream& output);

// Load initial conditions generated in AGAMA snapshot format.
// Returns true on success, false on parse/load errors.
bool loadAgamaSnapshot(ParticleSystem& system, const string& filePath);
