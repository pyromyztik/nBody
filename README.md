# N Body Simulation

Real-time N-body simulation with a C++ physics backend and a React+Vite frontend.

The backend runs Barnes-Hut + Velocity Verlet and streams binary FlatBuffer frames over WebSocket.
The frontend decodes frames and renders the system in 3D.

**Live Demo**: [https://pranavaathrey.github.io/nBody/](https://pranavaathrey.github.io/nBody/) *(connects when backend server is active)*

## Project Features

- C++ physics core using:
	- Barnes-Hut octree force approximation
	- Velocity Verlet integration
	- OpenMP parallelization
- WebSocket streaming server with Flatbuffers
- React frontend with interactive HUD
- Scenario system with prebuilt binaries and runtime-generated scenarios

## Visuals

![Galaxy](https://raw.githubusercontent.com/pranavaathrey/nBody/frontend/scenarios/preview/galaxy.png)

![Accretion Disk](https://raw.githubusercontent.com/pranavaathrey/nBody/frontend/scenarios/preview/accretion-disk.png)

![Stable Orbits](https://raw.githubusercontent.com/pranavaathrey/nBody/frontend/scenarios/preview/stable-orbits.png)

[Here](https://youtu.be/6zQPBgwvHOM) is a video demonstration of the project.


## Prerequisites

1. C++17 compiler (GCC/Clang)
2. CMake 3.24+
3. Node.js 18+ and npm
4. Python 3.x (backend tries `python`, then `py -3`) with `numpy` (runtime-generated scenarios)

    Notes:
- `galaxy` and `galaxy-collision` do not need Python at runtime because they load prebuilt `.bin` snapshots.
- The galaxy generation workflows require extra libraries like `agama`, but those are not needed for normal runtime.

## Build and Run

Open two terminals from the repository root.

### Build Backend

Build with CMake:
```powershell
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### Running the Backend

The backend supports two operating modes:

#### 1. Hosted Multi-User Mode (Default)
Run in public/hosted mode:

Set the `SIM_MASTER_PASSWORD` environment variable before starting the backend so you can authenticate as Master:
```powershell
# Windows (PowerShell)
$env:SIM_MASTER_PASSWORD = "your_secure_password"
.\build\nbody_ws.exe

# Linux / macOS (Bash)
export SIM_MASTER_PASSWORD="your_secure_password"
./build/nbody_ws
```
*(If unset, master password authentication is disabled).*

- **Master Authentication**: One operator logs in as Master to configure and run simulations. Includes brute-force protection (maximum 5 attempts per day).
- **Spectator Mode**: Up to 6 spectators can join concurrently to watch simulations live, inspect telemetry, and switch cameras without disrupting the simulation.
- **Daily Compute Quota**: Tracks cumulative simulation run time (1 hour per day shared across users) with state persistence and live remaining compute ring indicator in the HUD.

#### 2. Locally-Hosted Mode (Recommended for Local Development)
Run without compute quotas, password authentication, or spectator caps:
```powershell
./build/nbody_ws.exe --locally-hosted
# or using the shorthand:
./build/nbody_ws.exe -lh
```
*(On Linux: `./build/nbody_ws --locally-hosted` or `./build/nbody_ws -lh`)*

---

### Install and Run Frontend

```powershell
cd frontend
npm install
npm run dev
```

### Start a Scenario

1. Open the frontend in your browser (e.g., `http://localhost:5173`)
2. In locally-hosted mode, simply choose a scenario on the landing page and click **Simulate**.
3. In hosted mode, authenticate as the Master to select scenarios, or join as a spectator if a simulation is already running.

The frontend sends scenario and control messages over WebSocket, and 3D rendering begins as soon as the binary frame stream starts.

