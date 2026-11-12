#!/usr/bin/env python3
"""Builds the C++20 engine: the pybind11 module and the standalone test bench.

Picks a toolchain automatically:
  1. CMake + a C++20 system compiler (g++ >= 10 or clang++ >= 12). Used in Docker and on Linux/macOS.
  2. The `ziglang` package from the backend's dev dependencies. It carries a full clang toolchain,
     so Windows machines can build with nothing installed beyond `uv sync`.

Run from anywhere with the backend environment:
    uv run --project backend python scripts/build_cpp.py [--zig] [--wasm] [--module-only]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "cpp_engine"
SOURCES = ["geometry.cpp", "fft2d.cpp", "nfp_placer.cpp", "solver.cpp"]


def run(cmd: list[str], cwd: Path = ROOT) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], cwd=cwd, check=True)


def system_compiler() -> str | None:
    for name, minimum in (("g++", 10), ("clang++", 12), ("c++", 10)):
        path = shutil.which(name)
        if not path:
            continue
        try:
            out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30).stdout
        except OSError:
            continue
        match = re.search(r"(\d+)\.\d+", out)
        if match and int(match.group(1)) >= minimum:
            return path
    return None


def build_with_cmake(compiler: str, module: bool) -> None:
    import pybind11  # noqa: PLC0415

    cmake = shutil.which("cmake")
    if cmake is None:
        import cmake as cmake_pkg  # noqa: PLC0415

        cmake = str(Path(cmake_pkg.CMAKE_BIN_DIR) / "cmake")
    build = ENGINE / "build"
    args = [
        cmake,
        "-S", ENGINE,
        "-B", build,
        f"-DCMAKE_CXX_COMPILER={compiler}",
        f"-DPython_EXECUTABLE={sys.executable}",
        f"-Dpybind11_DIR={pybind11.get_cmake_dir()}",
        f"-DCUTZERO_BUILD_MODULE={'ON' if module else 'OFF'}",
        "-DCMAKE_BUILD_TYPE=Release",
    ]
    run(args)
    run([cmake, "--build", build, "--parallel"])


def build_with_zig(module: bool, bench: bool) -> None:
    import pybind11  # noqa: PLC0415

    zig = [sys.executable, "-m", "ziglang", "c++"]
    common = ["-std=c++20", "-O3", "-DNDEBUG", "-I", ENGINE / "include"]
    sources = [ENGINE / "src" / name for name in SOURCES]
    is_windows = sys.platform == "win32"
    target = ["-target", "x86_64-windows-gnu", "-mcpu=x86_64_v3"] if is_windows else []
    (ENGINE / "build").mkdir(exist_ok=True)

    if bench:
        exe = ENGINE / "build" / ("test_bench.exe" if is_windows else "test_bench")
        run([*zig, *common, *target, *sources, ENGINE / "src" / "test_bench.cpp", "-o", exe])

    if module:
        suffix = sysconfig.get_config_var("EXT_SUFFIX") or (".pyd" if is_windows else ".so")
        output = ROOT / "backend" / "app" / f"_cutzero_core{suffix}"
        include = sysconfig.get_path("include")
        cmd = [*zig, *common, *target, "-shared", "-I", pybind11.get_include(), "-I", include,
               *sources, ENGINE / "src" / "bindings.cpp"]
        if is_windows:
            base = Path(sys.base_prefix)
            libname = f"python{sys.version_info.major}{sys.version_info.minor}"
            cmd += ["-L", base, f"-l{libname}"]
        else:
            cmd += ["-fPIC"]
        run([*cmd, "-o", output])
        # Windows linkers leave debug and import-library files next to the module; they are not needed.
        for leftover in output.parent.glob("*.pdb"):
            leftover.unlink(missing_ok=True)
        for leftover in output.parent.glob("*.lib"):
            leftover.unlink(missing_ok=True)
        print(f"Built {output}")


def build_wasm() -> None:
    """Compiles the same engine to WebAssembly so the studio can run with no server at all."""
    zig = [sys.executable, "-m", "ziglang", "c++"]
    output = ROOT / "frontend" / "public" / "cutzero_core.wasm"
    sources = [ENGINE / "src" / name for name in SOURCES]
    run([
        *zig,
        "-target", "wasm32-wasi",
        "-std=c++20", "-O3", "-DNDEBUG", "-DCUTZERO_NO_THREADS",
        "-msimd128",
        "-fno-exceptions",
        "-mexec-model=reactor",
        "-Wl,--no-entry",
        "-Wl,--initial-memory=67108864",
        "-Wl,--max-memory=1073741824",
        "-Wl,--export=__heap_base",
        "-s",
        "-I", ENGINE / "include",
        *sources,
        ENGINE / "src" / "wasm_api.cpp",
        "-o", output,
    ])
    print(f"Built {output} ({output.stat().st_size / 1024:.0f} KiB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zig", action="store_true", help="force the ziglang toolchain")
    parser.add_argument("--wasm", action="store_true", help="also build the WebAssembly engine")
    parser.add_argument("--wasm-only", action="store_true", help="build only the WebAssembly engine")
    parser.add_argument("--module-only", action="store_true", help="skip the test bench when using zig")
    args = parser.parse_args()

    if not args.wasm_only:
        compiler = None if args.zig else system_compiler()
        if compiler:
            print(f"Using system compiler: {compiler}")
            build_with_cmake(compiler, module=True)
        else:
            print("No C++20 system compiler found; using the ziglang toolchain.")
            build_with_zig(module=True, bench=not args.module_only)
    if args.wasm or args.wasm_only:
        build_wasm()


if __name__ == "__main__":
    main()
