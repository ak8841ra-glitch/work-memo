"""アプリアイコン（PNG）を生成する。Python標準ライブラリのみ使用。

使い方:  python3 tools/make-icons.py
"""
import os
import struct
import zlib

BG = (31, 95, 102)       # 背景（アクセント色）
PAPER = (250, 250, 246)  # 紙
LINE = (31, 95, 102)     # 罫線


def draw(size):
    s = size
    # 紙：中央 52% × 62%、角丸（maskable の安全領域に収まる大きさ）
    pw, ph = s * 0.52, s * 0.62
    x0, y0 = (s - pw) / 2, (s - ph) / 2
    x1, y1 = x0 + pw, y0 + ph
    r = s * 0.05
    lines = [y0 + ph * f for f in (0.28, 0.46, 0.64, 0.82)]
    lw = max(1.0, s * 0.028)
    lx0, lx1 = x0 + pw * 0.16, x1 - pw * 0.16
    rows = []
    for y in range(s):
        row = bytearray([0])
        cy = y + 0.5
        for x in range(s):
            cx = x + 0.5
            color = BG
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                # 角丸判定
                dx = max(x0 + r - cx, 0, cx - (x1 - r))
                dy = max(y0 + r - cy, 0, cy - (y1 - r))
                if dx * dx + dy * dy <= r * r:
                    color = PAPER
                    last = len(lines) - 1
                    for i, ly in enumerate(lines):
                        end = lx1 if i < last else lx0 + (lx1 - lx0) * 0.55
                        if abs(cy - ly) <= lw / 2 and lx0 <= cx <= end:
                            color = LINE
            row.extend(color)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", s, s, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        with open(os.path.join(out, name), "wb") as f:
            f.write(draw(size))
        print("wrote", name)
