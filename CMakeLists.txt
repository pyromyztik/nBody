cmake_minimum_required(VERSION 3.24)
project(nbody LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

if(MSVC)
    add_compile_options(/O2 /W3)
else()
    add_compile_options(-O3 -march=native -Wall -Wextra)
endif()

if(WIN32)
    add_compile_definitions(_HAS_STD_BYTE=0)
    list(APPEND CMAKE_PREFIX_PATH "C:/Windows/msys64/mingw64" "C:/msys64/mingw64")
endif()

find_package(OpenMP REQUIRED)
find_package(ZLIB)
if(NOT ZLIB_FOUND)
    find_path(ZLIB_INCLUDE_DIR zlib.h PATHS "C:/Windows/msys64/mingw64/include" "C:/msys64/mingw64/include" "/usr/include")
    find_library(ZLIB_LIBRARY NAMES z zlib PATHS "C:/Windows/msys64/mingw64/lib" "C:/msys64/mingw64/lib" "/usr/lib")
    if(ZLIB_INCLUDE_DIR AND ZLIB_LIBRARY)
        add_library(ZLIB::ZLIB UNKNOWN IMPORTED)
        set_target_properties(ZLIB::ZLIB PROPERTIES
            IMPORTED_LOCATION "${ZLIB_LIBRARY}"
            INTERFACE_INCLUDE_DIRECTORIES "${ZLIB_INCLUDE_DIR}"
        )
        set(ZLIB_FOUND TRUE)
    else()
        message(FATAL_ERROR "ZLIB not found")
    endif()
endif()

include(FetchContent)

if(WIN32)
    FetchContent_Declare(
        libuv
        GIT_REPOSITORY https://github.com/libuv/libuv.git
        GIT_TAG        v1.48.0
        GIT_SHALLOW    ON
        GIT_SUBMODULES ""
    )
    set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(libuv)
endif()

FetchContent_Declare(
    uSockets
    GIT_REPOSITORY https://github.com/uNetworking/uSockets.git
    GIT_TAG        v0.8.8
    GIT_SHALLOW    ON
    GIT_SUBMODULES ""
)
FetchContent_MakeAvailable(uSockets)

file(GLOB USOCKETS_C_SOURCES "${usockets_SOURCE_DIR}/src/*.c")

if(WIN32)
    set(USOCKETS_SOURCES
        ${USOCKETS_C_SOURCES}
        "${usockets_SOURCE_DIR}/src/eventing/libuv.c"
    )
    add_library(uSockets STATIC ${USOCKETS_SOURCES})
    target_include_directories(uSockets PUBLIC ${usockets_SOURCE_DIR}/src)
    target_compile_definitions(uSockets PUBLIC LIBUS_USE_LIBUV LIBUS_NO_SSL)
    target_link_libraries(uSockets PUBLIC uv_a ws2_32 mswsock iphlpapi userenv psapi)
else()
    set(USOCKETS_SOURCES
        ${USOCKETS_C_SOURCES}
        "${usockets_SOURCE_DIR}/src/eventing/epoll_kqueue.c"
    )
    add_library(uSockets STATIC ${USOCKETS_SOURCES})
    target_include_directories(uSockets PUBLIC ${usockets_SOURCE_DIR}/src)
    target_compile_definitions(uSockets PUBLIC LIBUS_USE_EPOLL LIBUS_NO_SSL)
    target_link_libraries(uSockets PUBLIC pthread)
endif()

FetchContent_Declare(
    uWebSockets
    GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
    GIT_TAG        v20.71.0
    GIT_SHALLOW    ON
    GIT_SUBMODULES ""
)
FetchContent_MakeAvailable(uWebSockets)

add_library(uWebSockets INTERFACE)
target_include_directories(uWebSockets INTERFACE ${uwebsockets_SOURCE_DIR}/src)
target_link_libraries(uWebSockets INTERFACE uSockets ZLIB::ZLIB)

# Executable target
add_executable(nbody_ws
    src/main.cpp
    src/velocityVerlet.cpp
    src/barnesHutTree.cpp
    src/scenarios.cpp
)

target_include_directories(nbody_ws PRIVATE
    src
    include
)

target_link_libraries(nbody_ws PRIVATE
    uWebSockets
    OpenMP::OpenMP_CXX
)

if(WIN32)
    target_link_libraries(nbody_ws PRIVATE ws2_32 mswsock)
endif()
