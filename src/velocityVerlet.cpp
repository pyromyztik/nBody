#include "nBodySim.hpp"

namespace {
class SimulationKernel {
    private:
    BarnesHutTree octree;

    static bool isLeaf(const OctreeNode& node) {
        for (int i = 0; i < 8; ++i) 
            if (node.children[i] != -1) return false;
        return true;
    }

    static void accumulateForce(float dx, float dy, float dz, float distSq, float sourceMass,
                                float particleMass, float& fx, float& fy, float& fz) {
        const float invDist = 1.0f / sqrt(distSq + SOFTENING_SQ);
        const float invDist3 = invDist * invDist * invDist;
        const float scale = G_CONST * particleMass * sourceMass * invDist3;
        fx += scale * dx;
        fy += scale * dy;
        fz += scale * dz;
    }

    static void applyForceFromTree(int pIdx, ParticleSystem& system,
                                   const vector<OctreeNode>& nodes, vector<int>& stack) {
        stack.clear();
        stack.push_back(0);

        const float px = system.posXAt(pIdx);
        const float py = system.posYAt(pIdx);
        const float pz = system.posZAt(pIdx);
        const float particleMass = system.massAt(pIdx);

        float fx = 0.0f;
        float fy = 0.0f;
        float fz = 0.0f;

        while (!stack.empty()) {
            const int nodeIdx = stack.back();
            stack.pop_back();
            const OctreeNode& node = nodes[nodeIdx];

            if (node.totalMass <= 0.0f) continue;

            const float dx = node.centerMassX - px;
            const float dy = node.centerMassY - py;
            const float dz = node.centerMassZ - pz;
            const float distSq = dx * dx + dy * dy + dz * dz;

            if (isLeaf(node)) {
                if (node.particleIndex == -1 || node.particleIndex == pIdx) continue;
                accumulateForce(dx, dy, dz, distSq, node.totalMass, particleMass, fx, fy, fz);
                continue;
            }
            const float sizeX = node.maxX - node.minX;
            const float sizeY = node.maxY - node.minY;
            const float sizeZ = node.maxZ - node.minZ;
            const float size = max(sizeX, max(sizeY, sizeZ));
            const float dist = sqrt(distSq + SOFTENING_SQ);

            if ((size / dist) < THETA)
                accumulateForce(dx, dy, dz, distSq, node.totalMass, particleMass, fx, fy, fz);
            else 
                for (int i = 0; i < 8; ++i) {
                    const int childIdx = node.children[i];
                    if (childIdx != -1) 
                        stack.push_back(childIdx);
                }
        }
        system.setForce(static_cast<size_t>(pIdx), fx, fy, fz);
    }

    public:
    void initializeForces(ParticleSystem& system) {
        octree.build(system);
        calculateForces(system);
    }
    void calculateForces(ParticleSystem& system) {
        const vector<OctreeNode>& nodes = octree.getNodes();
        if (nodes.empty()) return;

        const size_t n = system.size();
        #ifdef _OPENMP
        #pragma omp parallel
        {
            vector<int> stack;
            stack.reserve(128);
            #pragma omp for
            for (ptrdiff_t i = 0; i < static_cast<ptrdiff_t>(n); ++i) 
                applyForceFromTree(static_cast<int>(i), system, nodes, stack);
        }
        #else
        vector<int> stack;
        stack.reserve(128);
        for (ptrdiff_t i = 0; i < static_cast<ptrdiff_t>(n); ++i) 
            applyForceFromTree(static_cast<int>(i), system, nodes, stack);
        #endif
    }
    void clearForces(ParticleSystem& system) const {
        const size_t n = system.size();
        #ifdef _OPENMP
        #pragma omp parallel for
        #endif
        for (ptrdiff_t i = 0; i < static_cast<ptrdiff_t>(n); ++i)
            system.setForceZero(static_cast<size_t>(i));
    }

    void physicsTick(ParticleSystem& system, float dt) {
        const size_t n = system.size();
        const float halfDt = 0.5f * dt;
        const float halfDtSq = halfDt * dt;

        // First half-step: position and velocity updates from current acceleration.
        #ifdef _OPENMP
        #pragma omp parallel for
        #endif
        for (ptrdiff_t idx = 0; idx < static_cast<ptrdiff_t>(n); ++idx) {
            const size_t i = static_cast<size_t>(idx);
            BodyBlock& blk = system.block(i);
            const size_t lane = ParticleSystem::laneIndex(i);

            const float ax = blk.forceX[lane] * blk.invMass[lane];
            const float ay = blk.forceY[lane] * blk.invMass[lane];
            const float az = blk.forceZ[lane] * blk.invMass[lane];

            blk.posX[lane] += blk.velX[lane] * dt + ax * halfDtSq;
            blk.posY[lane] += blk.velY[lane] * dt + ay * halfDtSq;
            blk.posZ[lane] += blk.velZ[lane] * dt + az * halfDtSq;

            blk.velX[lane] += ax * halfDt;
            blk.velY[lane] += ay * halfDt;
            blk.velZ[lane] += az * halfDt;
        }
        octree.build(system);
        calculateForces(system);

        // Second half-step: finalize velocity with updated acceleration.
        #ifdef _OPENMP
        #pragma omp parallel for
        #endif
        for (ptrdiff_t idx = 0; idx < static_cast<ptrdiff_t>(n); ++idx) {
            const size_t i = static_cast<size_t>(idx);
            BodyBlock& blk = system.block(i);
            const size_t lane = ParticleSystem::laneIndex(i);

            const float ax = blk.forceX[lane] * blk.invMass[lane];
            const float ay = blk.forceY[lane] * blk.invMass[lane];
            const float az = blk.forceZ[lane] * blk.invMass[lane];

            blk.velX[lane] += ax * halfDt;
            blk.velY[lane] += ay * halfDt;
            blk.velZ[lane] += az * halfDt;
        }
    }
};

SimulationKernel& kernel() {
    static SimulationKernel instance;
    return instance;
}
}

void clearForces(ParticleSystem& system) {
    kernel().clearForces(system);
}
void calculateForces(ParticleSystem& system) {
    kernel().calculateForces(system);
}
void initializeForces(ParticleSystem& system) {
    kernel().initializeForces(system);
}
void physicsTick(ParticleSystem& system, float dt) {
    kernel().physicsTick(system, dt);
}
