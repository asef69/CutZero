"""Prints the imports and exports of the compiled WebAssembly engine."""
from pathlib import Path

data = (Path(__file__).resolve().parents[1] / "frontend" / "public" / "cutzero_core.wasm").read_bytes()


def leb(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 127) << shift
        shift += 7
        if not byte & 128:
            return result, i


i = 8
while i < len(data):
    section = data[i]
    size, i = leb(data, i + 1)
    j = i
    if section == 2:
        count, j = leb(data, j)
        for _ in range(count):
            n, j = leb(data, j)
            module = data[j:j + n].decode()
            j += n
            n, j = leb(data, j)
            name = data[j:j + n].decode()
            j += n
            kind = data[j]
            j += 1
            if kind == 0:
                _, j = leb(data, j)
            elif kind == 2:
                flags = data[j]
                j += 1
                _, j = leb(data, j)
                if flags & 1:
                    _, j = leb(data, j)
            print("import", module, name, kind)
    if section == 7:
        count, j = leb(data, j)
        for _ in range(count):
            n, j = leb(data, j)
            name = data[j:j + n].decode()
            j += n
            kind = data[j]
            j += 1
            _, j = leb(data, j)
            print("export", name, kind)
    i += size
