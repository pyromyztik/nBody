
#pragma once

#include <vector>
#include <cmath>
#include <limits>
#include <algorithm>
#include <cstddef>
#include <cstdint>

using namespace std;

// simulation constants (dimensionless toy units)
const float G_CONST = 1.0f;       // gravitational constant
const float THETA = 0.5f;         // Barnes-Hut threshold
const float SOFTENING_SQ = 0.1f;  // softening factor squared to prevent infinite forces

// universe

// AoSoA block tuned for AVX2 width (8 floats).
constexpr size_t BODY_BLOCK_SIZE = 8;

struct BodyBlock {
    alignas(32) float posX[BODY_BLOCK_SIZE];
    alignas(32) float posY[BODY_BLOCK_SIZE];
    alignas(32) float posZ[BODY_BLOCK_SIZE];

    alignas(32) float velX[BODY_BLOCK_SIZE];
    alignas(32) float velY[BODY_BLOCK_SIZE];
    alignas(32) float velZ[BODY_BLOCK_SIZE];

    alignas(32) float forceX[BODY_BLOCK_SIZE];
    alignas(32) float forceY[BODY_BLOCK_SIZE];
    alignas(32) float forceZ[BODY_BLOCK_SIZE];

    alignas(32) float mass[BODY_BLOCK_SIZE];
    alignas(32) float invMass[BODY_BLOCK_SIZE];

    uint8_t count = 0; // number of live lanes in this block
};

struct ParticleSystem {
    vector<BodyBlock> blocks;
    size_t count = 0;

    void allocate(size_t n) {
        count = n;
        const size_t blockCount = (n + BODY_BLOCK_SIZE - 1) / BODY_BLOCK_SIZE;
        blocks.resize(blockCount);
        for (size_t b = 0; b < blockCount; ++b) {
            BodyBlock& blk = blocks[b];
            blk.count = static_cast<uint8_t>(min(BODY_BLOCK_SIZE, n - b * BODY_BLOCK_SIZE));
            for (size_t lane = 0; lane < BODY_BLOCK_SIZE; ++lane) {
                blk.posX[lane] = 0.0f; blk.posY[lane] = 0.0f; blk.posZ[lane] = 0.0f;
                blk.velX[lane] = 0.0f; blk.velY[lane] = 0.0f; blk.velZ[lane] = 0.0f;
                blk.forceX[lane] = 0.0f; blk.forceY[lane] = 0.0f; blk.forceZ[lane] = 0.0f;
                blk.mass[lane] = 1.0f; blk.invMass[lane] = 1.0f;
            }
        }
    }

    // helpers to locate block/lane for a flat particle index
    static inline size_t blockIndex(size_t idx) { return idx / BODY_BLOCK_SIZE; }
    static inline size_t laneIndex(size_t idx) { return idx % BODY_BLOCK_SIZE; }

    inline BodyBlock& block(size_t idx) { return blocks[blockIndex(idx)]; }
    inline const BodyBlock& block(size_t idx) const { return blocks[blockIndex(idx)]; }

    // getters
    inline float posXAt(size_t idx) const { const auto& blk = block(idx); return blk.posX[laneIndex(idx)]; }
    inline float posYAt(size_t idx) const { const auto& blk = block(idx); return blk.posY[laneIndex(idx)]; }
    inline float posZAt(size_t idx) const { const auto& blk = block(idx); return blk.posZ[laneIndex(idx)]; }
    inline float velXAt(size_t idx) const { const auto& blk = block(idx); return blk.velX[laneIndex(idx)]; }
    inline float velYAt(size_t idx) const { const auto& blk = block(idx); return blk.velY[laneIndex(idx)]; }
    inline float velZAt(size_t idx) const { const auto& blk = block(idx); return blk.velZ[laneIndex(idx)]; }
    inline float massAt(size_t idx) const { const auto& blk = block(idx); return blk.mass[laneIndex(idx)]; }
    inline float invMassAt(size_t idx) const { const auto& blk = block(idx); return blk.invMass[laneIndex(idx)]; }
    inline float forceXAt(size_t idx) const { const auto& blk = block(idx); return blk.forceX[laneIndex(idx)]; }
    inline float forceYAt(size_t idx) const { const auto& blk = block(idx); return blk.forceY[laneIndex(idx)]; }
    inline float forceZAt(size_t idx) const { const auto& blk = block(idx); return blk.forceZ[laneIndex(idx)]; }

    // setters
    inline void setPosition(size_t idx, float x, float y, float z) {
        BodyBlock& blk = block(idx); const size_t lane = laneIndex(idx);
        blk.posX[lane] = x; blk.posY[lane] = y; blk.posZ[lane] = z;
    }
    inline void setVelocity(size_t idx, float x, float y, float z) {
        BodyBlock& blk = block(idx); const size_t lane = laneIndex(idx);
        blk.velX[lane] = x; blk.velY[lane] = y; blk.velZ[lane] = z;
    }
    inline void setForce(size_t idx, float fx, float fy, float fz) {
        BodyBlock& blk = block(idx); const size_t lane = laneIndex(idx);
        blk.forceX[lane] = fx; blk.forceY[lane] = fy; blk.forceZ[lane] = fz;
    }
    inline void setMass(size_t idx, float m) {
        BodyBlock& blk = block(idx); const size_t lane = laneIndex(idx);
        blk.mass[lane] = m; blk.invMass[lane] = 1.0f / m;
    }
    inline void setForceZero(size_t idx) { setForce(idx, 0.0f, 0.0f, 0.0f); }

    inline size_t size() const { return count; }
};
struct OctreeNode {
    float centerMassX, centerMassY, centerMassZ; 
    float totalMass;
    
    // bounding box for this node
    float minX, minY, minZ;          
    float maxX, maxY, maxZ;
    
    // -1 if this is an internal node, >= 0 if it holds a specific particle
    int particleIndex;               
    
    // indices to child nodes in the pre-allocated node vector (-1 if null)
    int children[8];                 

    OctreeNode() : totalMass(0.0f), particleIndex(-1) {
        for(int i = 0; i < 8; ++i) children[i] = -1;
    }
};

class BarnesHutTree {
    private:
    vector<OctreeNode> nodes;
    
    // safety mechanism to prevent infinite recursion for coincident particles
    static constexpr int MAX_DEPTH = 32; 

    // helper: allocates a new node and returns its index
    int allocateNode();
    // helper: determines which of the 8 octants a position belongs to
    int getOctant(const OctreeNode& node, float x, float y, float z) const;

    // helper: recursively inserts a particle into the tree
    void insertParticle(int nodeIdx, int pIdx, const ParticleSystem& system, int depth);

    // helper: computes mass and center of mass via post-order traversal
    void computeMassDistribution(int nodeIdx, const ParticleSystem& system);

    public:
    // expose the internal array for read-only 
    // access during the force calculation phase
    const vector<OctreeNode>& getNodes() const;

    void build(const ParticleSystem& system);
};

// physics

void physicsTick(ParticleSystem& system, float dt);
void initializeForces(ParticleSystem& system);

void clearForces(ParticleSystem& system);
void calculateForces(ParticleSystem& system); 
