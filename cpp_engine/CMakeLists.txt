cmake_minimum_required(VERSION 3.20)
project(cutzero_engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")

option(CUTZERO_BUILD_MODULE "Build the pybind11 extension module" ON)
option(CUTZERO_NATIVE "Tune for the build machine (do not use for portable images)" OFF)

add_library(cutzero_core STATIC
  src/geometry.cpp
  src/fft2d.cpp
  src/nfp_placer.cpp
  src/solver.cpp)
target_include_directories(cutzero_core PUBLIC include)
if(CUTZERO_NATIVE)
  target_compile_options(cutzero_core PUBLIC -march=native)
endif()

find_package(Threads REQUIRED)
target_link_libraries(cutzero_core PUBLIC Threads::Threads)

add_executable(test_bench src/test_bench.cpp)
target_link_libraries(test_bench PRIVATE cutzero_core)

if(CUTZERO_BUILD_MODULE)
  find_package(Python 3.12 COMPONENTS Interpreter Development.Module REQUIRED)
  find_package(pybind11 CONFIG REQUIRED)
  pybind11_add_module(_cutzero_core src/bindings.cpp)
  target_link_libraries(_cutzero_core PRIVATE cutzero_core)
  # The module lands next to the FastAPI app that imports it.
  set_target_properties(_cutzero_core PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../backend/app"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../backend/app")
endif()
