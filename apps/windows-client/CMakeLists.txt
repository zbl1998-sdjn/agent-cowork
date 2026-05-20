cmake_minimum_required(VERSION 3.24)
project(KimiCoworkWindowsClient LANGUAGES C CXX)

add_executable(KimiCowork WIN32
  src/main.c
  src/app_window.c
  src/tray.c
  src/native_bridge.c
  src/json.c
  src/webview_bridge.cpp
)

target_compile_features(KimiCowork PRIVATE c_std_17 cxx_std_17)
target_compile_definitions(KimiCowork PRIVATE UNICODE _UNICODE)
if(MSVC)
  target_compile_options(KimiCowork PRIVATE /utf-8)
endif()
target_link_libraries(KimiCowork PRIVATE user32 shell32 ole32)
