cmake_minimum_required(VERSION 3.20)
project(cpp_a LANGUAGES CXX)

add_executable(cpp-a main.cpp)
target_compile_features(cpp-a PRIVATE cxx_std_20)
install(TARGETS cpp-a RUNTIME DESTINATION bin)

