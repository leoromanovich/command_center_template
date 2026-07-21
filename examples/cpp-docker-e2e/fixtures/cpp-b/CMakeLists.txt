cmake_minimum_required(VERSION 3.20)
project(cpp_b LANGUAGES CXX)

add_executable(cpp-b main.cpp)
target_compile_features(cpp-b PRIVATE cxx_std_20)
install(TARGETS cpp-b RUNTIME DESTINATION bin)

