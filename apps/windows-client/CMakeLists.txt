cmake_minimum_required(VERSION 3.24)
project(KimiCoworkWindowsClient LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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

# WebView2 SDK (downloaded to build/webview2-sdk)
set(WV2_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/src/webview2")
target_include_directories(KimiCowork PRIVATE "${WV2_SDK_ROOT}")
target_link_directories(KimiCowork PRIVATE "${WV2_SDK_ROOT}")
target_link_libraries(KimiCowork PRIVATE
  user32 shell32 ole32 oleaut32
  WebView2Loader.dll.lib
)

# Copy WebView2Loader.dll next to the executable so it loads at runtime
add_custom_command(TARGET KimiCowork POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${WV2_SDK_ROOT}/WebView2Loader.dll"
    "$<TARGET_FILE_DIR:KimiCowork>/WebView2Loader.dll"
)
