# N Body Simulation

Real-time N-body simulation with a C++ physics backend and a React+Vite frontend.

The backend runs Barnes-Hut + Velocity Verlet and streams binary FlatBuffer frames over WebSocket.
The frontend decodes frames and renders the system in 3D.

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

## Build Instructions

Open two terminals from the repository root.

### Build and run backend

Build with CMake:
```powershell
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```
*(On Windows if you have multiple CMake installations, you can explicitly invoke `"C:\Program Files\CMake\bin\cmake.exe"`)*

Run:
```powershell
./build/nbody_ws.exe
```
*(On Linux: `./build/nbody_ws`)*

### Install and run frontend

```powershell
cd frontend
npm install
npm run dev
```

### Start a scenario

1. Open the frontend in a browser
2. Choose a scenario on the landing page
3. Click simulate

The frontend sends scenario + control messages, then rendering begins once first frame arrives.
