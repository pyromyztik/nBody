#include "nBodySim.hpp"

namespace {
inline bool isLeaf(const OctreeNode& node) {
    for (int i = 0; i < 8; ++i) 
        if (node.children[i] != -1) return false;
    return true;
}

inline void setChildBounds(OctreeNode& child, const OctreeNode& parent, int octant) {
    const float midX = (parent.minX + parent.maxX) * 0.5f;
    const float midY = (parent.minY + parent.maxY) * 0.5f;
    const float midZ = (parent.minZ + parent.maxZ) * 0.5f;

    child.minX = (octant & 1) ? midX : parent.minX;
    child.maxX = (octant & 1) ? parent.maxX : midX;
    child.minY = (octant & 2) ? midY : parent.minY;
    child.maxY = (octant & 2) ? parent.maxY : midY;
    child.minZ = (octant & 4) ? midZ : parent.minZ;
    child.maxZ = (octant & 4) ? parent.maxZ : midZ;
}
}

int BarnesHutTree::allocateNode() {
    nodes.push_back(OctreeNode());
    return static_cast<int>(nodes.size()) - 1;
}
// gets octant index for given point in node
int BarnesHutTree::getOctant(const OctreeNode& node, float x, float y, float z) const {
    float midX = (node.minX + node.maxX) * 0.5f;
    float midY = (node.minY + node.maxY) * 0.5f;
    float midZ = (node.minZ + node.maxZ) * 0.5f;
    
    int octant = 0;
    if (x >= midX) octant |= 1;
    if (y >= midY) octant |= 2;
    if (z >= midZ) octant |= 4;
    return octant;
}

void BarnesHutTree::insertParticle(int nodeIdx, int pIdx, 
                                   const ParticleSystem& system, int depth) {
    if (depth >= MAX_DEPTH) {
        // reached maximum depth; force the particle into this leaf 
        // to prevent stack overflow
        nodes[nodeIdx].particleIndex = pIdx;
        return;
    }
    // empty leaf
    if (nodes[nodeIdx].particleIndex == -1 && isLeaf(nodes[nodeIdx])) {
        nodes[nodeIdx].particleIndex = pIdx;
        return;
    }    
    // occupied leaf, subdivide
    if (nodes[nodeIdx].particleIndex != -1) {
        int existingPIdx = nodes[nodeIdx].particleIndex;
        nodes[nodeIdx].particleIndex = -1; 

        int octantExisting = getOctant(nodes[nodeIdx], 
            system.posXAt(existingPIdx), 
            system.posYAt(existingPIdx), 
            system.posZAt(existingPIdx));
        if (nodes[nodeIdx].children[octantExisting] == -1) {
            const int childIdx = allocateNode();
            nodes[nodeIdx].children[octantExisting] = childIdx;
            setChildBounds(nodes[childIdx], nodes[nodeIdx], octantExisting);
        }
        insertParticle(nodes[nodeIdx].children[octantExisting], 
                        existingPIdx, system, depth + 1);
    }        
    // insert new particle
    int octantNew = getOctant(nodes[nodeIdx], 
                        system.posXAt(pIdx), system.posYAt(pIdx), system.posZAt(pIdx));
    if (nodes[nodeIdx].children[octantNew] == -1) {
        const int childIdx = allocateNode();
        nodes[nodeIdx].children[octantNew] = childIdx;
        setChildBounds(nodes[childIdx], nodes[nodeIdx], octantNew);
    }
    insertParticle(nodes[nodeIdx].children[octantNew], pIdx, system, depth + 1);
}

void BarnesHutTree::computeMassDistribution(int nodeIdx, const ParticleSystem& system) {
    OctreeNode& node = nodes[nodeIdx];
    
    if (isLeaf(node)) {
        // if leaf holds a particle, set particle's mass and center
        if (node.particleIndex != -1) {
            node.totalMass = system.massAt(node.particleIndex);

            node.centerMassX = system.posXAt(node.particleIndex);
            node.centerMassY = system.posYAt(node.particleIndex);
            node.centerMassZ = system.posZAt(node.particleIndex);
        }
        return; // otherwise, leave as is
    }    
    node.totalMass = 0.0f;

    node.centerMassX = 0.0f;
    node.centerMassY = 0.0f;
    node.centerMassZ = 0.0f;
    
    // recurse into children and accumulate mass
    for (int i = 0; i < 8; ++i) {
        int childIdx = node.children[i];
        if (childIdx == -1) continue; // no children

        computeMassDistribution(childIdx, system);
        
        float childMass = nodes[childIdx].totalMass;
        if (childMass > 0.0f) {
            node.totalMass += childMass;

            node.centerMassX += nodes[childIdx].centerMassX * childMass;
            node.centerMassY += nodes[childIdx].centerMassY * childMass;
            node.centerMassZ += nodes[childIdx].centerMassZ * childMass;
        }
    }    
    // get center of mass
    if (node.totalMass > 0.0f) {
        node.centerMassX /= node.totalMass;
        node.centerMassY /= node.totalMass;
        node.centerMassZ /= node.totalMass;
    }
}

const vector<OctreeNode>& BarnesHutTree::getNodes() const {
    return nodes;
}

void BarnesHutTree::build(const ParticleSystem& system) {
    const size_t n = system.size();
    nodes.clear();
    if (n == 0) return;

    // reserve memory upfront
    nodes.reserve(n * 2); 

    // find axis-aligned bounds enclosing all particles
    float minX = numeric_limits<float>::max();
    float maxX = -numeric_limits<float>::max();
    float minY = numeric_limits<float>::max();
    float maxY = -numeric_limits<float>::max();
    float minZ = numeric_limits<float>::max();
    float maxZ = -numeric_limits<float>::max();

    for (size_t i = 0; i < n; ++i) {
        const float px = system.posXAt(i);
        const float py = system.posYAt(i);
        const float pz = system.posZAt(i);
        minX = min(minX, px); maxX = max(maxX, px);
        minY = min(minY, py); maxY = max(maxY, py);
        minZ = min(minZ, pz); maxZ = max(maxZ, pz);
    }    
    // padding for zero-size boxes
    float epsilon = 1e-5f;
    minX -= epsilon; maxX += epsilon;
    minY -= epsilon; maxY += epsilon;
    minZ -= epsilon; maxZ += epsilon;

    // create root node
    int rootIdx = allocateNode();
    nodes[rootIdx].minX = minX; nodes[rootIdx].maxX = maxX;
    nodes[rootIdx].minY = minY; nodes[rootIdx].maxY = maxY;
    nodes[rootIdx].minZ = minZ; nodes[rootIdx].maxZ = maxZ;

    // insert all particles into tree
    for (size_t i = 0; i < n; ++i) 
        insertParticle(rootIdx, static_cast<int>(i), system, 0);
    // compute mass & center of mass
    computeMassDistribution(rootIdx, system);
}
