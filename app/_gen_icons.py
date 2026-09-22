# -*- coding: utf-8 -*-
"""
从两张原图生成两套 App 图标资源（普通会员 / Pro 会员）。

为什么要生成两套、每套还要拆成整图 + 前景 + 背景：

  1) 桌面图标切换（activity-alias + PackageManager）只认一个 drawable，
     所以每套要有一张**整图**作为 alias 的 android:icon；

  2) 但线上现在用的是 adaptive icon（mipmap-anydpi-v26/*.xml 里
     background + foreground 两层）。Android 8+ 对**非 adaptive** 的图标
     会自行加白底并把内容缩到约 72%，观感与现在不一致 —— 所以每套也要
     做成 adaptive：前景只留主体（透明底），背景交给一层纯色。

  3) adaptive 前景有**安全区**：108dp 里只有中间 66dp 保证不被裁掉。
     对应到像素就是把内容缩到画布的 66/108 ≈ 61%，居中放置、四周透明。
     直接把整图当 foreground 会在圆形/方形遮罩下被裁掉一圈。

用法：python _gen_icons.py
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("需要 Pillow：pip install Pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, 'assets')
RES = os.path.join(HERE, 'android', 'app', 'src', 'main', 'res')

# 两份原图。文件名里的中文是当初生成时的提示词，含空格与特殊字符，
# 所以用前缀匹配而不是写死全名 —— 换图时只要改前缀。
SRC = {
    'free': ('手机_App_图标设计_圆角方形_干净的纯白背景', '白底金猪（普通会员）'),
    'pro': ('手机_App_图标设计_圆角方形_深藏青近黑渐变背景', '深色金猪（Pro 会员）'),
}

# 传统 mipmap 各档尺寸（整图用）
LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
# adaptive icon 的前景/背景尺寸
ADAPTIVE = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

# adaptive 安全区比例：66 / 108
SAFE = 66.0 / 108.0


def find_source(prefix):
    for name in sorted(os.listdir(ASSETS)):
        if name.startswith(prefix) and name.lower().endswith('.png'):
            return os.path.join(ASSETS, name)
    raise SystemExit('在 assets/ 里找不到以「%s」开头的图片' % prefix)


def edge_color(img):
    """
    取图片四边内缩处的平均色，作为 adaptive 的背景色。

    两个坑都踩过了，这里一并说明：

    1) **采样点必须内缩**。两份原图都是「圆角方形 + 四周透明」，
       四角落在圆角之外的透明区。直接采 (0,0) 会把透明像素（RGBA 全 0）
       也算进去，得到一个被拉灰的颜色 —— 实测近黑那张采出来是
       rgb(139,140,142)，明显不对。

    2) **只取边缘，不取全图平均**。全图平均会被画面中央的主体（那只猪）
       带偏大半，而 adaptive 的背景层只在主体四周露出一圈，取边缘色才接得上。
    """
    w, h = img.size
    m = max(1, int(min(w, h) * 0.08))
    pts = [
        (w // 2, m),          # 上
        (w // 2, h - 1 - m),  # 下
        (m, h // 2),          # 左
        (w - 1 - m, h // 2),  # 右
    ]
    # 只统计不透明像素：万一还有别的透明点混进来，也不会污染结果
    px = [img.getpixel(p) for p in pts]
    solid = [c for c in px if len(c) < 4 or c[3] > 200]
    if not solid:
        solid = px
    n = len(solid)
    return tuple(sum(c[i] for c in solid) // n for i in range(3))


def strip_white_border(src):
    """
    把原图四周的白色变成透明，并裁到实际内容。

    为什么必须这么做 —— 这是「图标四周有一圈白边」的根因：

      两份原图都是**带白色留白的整图**（四角 RGBA = 255,255,255,255，
      实测白边约 6%）。当我把这样的整图直接当 adaptive 的 foreground 时，
      那圈白边就跟着一起被画出来了 —— 而且因为它比主体大一圈，
      看起来特别显眼，像是图片没裁干净。

    做法是**从四角做 flood fill**，而不是「把所有白色变透明」：
    后者会把白猪版那只猪身上、被金色包围的白色一起吃掉，
    整只猪会变成镂空。flood fill 只影响**与四角连通**的白色区域，
    圆角之外的留白正好属于这一片，猪身的白则被金边隔开、不受影响。
    """
    img = src.convert('RGBA').copy()
    w, h = img.size

    # 阈值给得比"纯白"宽一些：原图边缘受渐变与压缩影响，不全是 255
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(img, corner, (0, 0, 0, 0), thresh=90)

    # 按 alpha 裁到内容边界
    box = img.getbbox()
    return img.crop(box) if box else img


def make_foreground(src, size):
    """
    把「去掉白色留白后的主体」缩到安全区，居中贴到透明画布上。

    两个要点：

      1) **先去掉原图自带的留白**（见 strip_white_border）。原图是完整的
         图标设计，自带一圈边距；直接缩到安全区等于**重复留白**，
         那圈白边就是这么露出来的。

      2) **缩到 SAFE（66/108）而不是铺满**。因为 adaptive 的遮罩会吃掉
         四周约 18%，内容必须留在中心安全区内。这一步不是多余的 ——
         只有配上第 1 步，留白才是"恰好一份"。
    """
    art = strip_white_border(src)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    inner = max(1, int(round(size * SAFE)))
    art = art.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.paste(art, (off, off), art)
    return canvas


def main():
    sources = {}
    for key, (prefix, label) in SRC.items():
        path = find_source(prefix)
        src = Image.open(path).convert('RGBA')
        sources[key] = src
        print('源图 %s：%s  (%dx%d)' % (key, os.path.basename(path), src.size[0], src.size[1]))

        bg = edge_color(src)
        print('  背景取样色 rgb%s' % (bg,))

        for dpi, px in LEGACY.items():
            out_dir = os.path.join(RES, 'mipmap-' + dpi)
            os.makedirs(out_dir, exist_ok=True)

            # 整图：给 activity-alias 用，也作为 adaptive 不可用时的兜底。
            # 这里也先去掉白边 —— 非 adaptive 环境下 Android 会把整图缩到约 72%
            # 再套一层白底，留着原图那圈白边等于白边叠白边，尤其明显。
            art = strip_white_border(src)
            art.resize((px, px), Image.LANCZOS).save(
                os.path.join(out_dir, 'ic_launcher_%s.png' % key), 'PNG', optimize=True)

            # adaptive 的两层
            size = ADAPTIVE[dpi]
            make_foreground(src, size).save(
                os.path.join(out_dir, 'ic_launcher_%s_foreground.png' % key), 'PNG', optimize=True)
            Image.new('RGBA', (size, size), bg + (255,)).save(
                os.path.join(out_dir, 'ic_launcher_%s_background.png' % key), 'PNG', optimize=True)

        print('  → 已生成 5 档 dpi（整图 / 前景 / 背景）')

    # 顺带把**原图标**也修一遍。
    #
    # 为什么还要管它：activity-alias 已经各自指定了新图标，但 <application>
    # 上的 android:icon="@mipmap/ic_launcher" 依然在生效 —— 设置里的"应用信息"、
    # 部分第三方启动器、以及别名不可用的老系统都会读它。而它同样带着那圈白边
    # （实测 5.8%），不改的话问题只修了一半。
    #
    # 用 pro 那份原图，与 App 当前的深色主题一致。
    legacy_src = sources['pro']
    legacy_bg = edge_color(legacy_src)
    legacy_art = strip_white_border(legacy_src)
    for dpi, px in LEGACY.items():
        out_dir = os.path.join(RES, 'mipmap-' + dpi)
        legacy_art.resize((px, px), Image.LANCZOS).save(
            os.path.join(out_dir, 'ic_launcher.png'), 'PNG', optimize=True)
        legacy_art.resize((px, px), Image.LANCZOS).save(
            os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG', optimize=True)
        size = ADAPTIVE[dpi]
        make_foreground(legacy_src, size).save(
            os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG', optimize=True)
    print('已同时更新原图标 ic_launcher / ic_launcher_round / ic_launcher_foreground')

    # adaptive icon 的 XML（每档 dpi 共用一份，放在 anydpi-v26）
    anydpi = os.path.join(RES, 'mipmap-anydpi-v26')
    os.makedirs(anydpi, exist_ok=True)
    for key in SRC:
        xml = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@mipmap/ic_launcher_%s_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_%s_foreground"/>\n'
            '</adaptive-icon>\n' % (key, key)
        )
        with open(os.path.join(anydpi, 'ic_launcher_%s.xml' % key), 'w', encoding='utf-8') as f:
            f.write(xml)
    print('已生成 mipmap-anydpi-v26/ic_launcher_free.xml 与 ic_launcher_pro.xml')

    # 自检：确认关键文件都在
    print('\n自检：')
    missing = 0
    for key in SRC:
        for dpi in LEGACY:
            for suffix in ('', '_foreground', '_background'):
                p = os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher_%s%s.png' % (key, suffix))
                if not os.path.exists(p):
                    print('  缺失 %s' % p)
                    missing += 1
    if missing == 0:
        print('  全部 %d 个 png + 2 个 xml 就位' % (len(SRC) * len(LEGACY) * 3))
    else:
        sys.exit('%d 个文件缺失' % missing)


if __name__ == '__main__':
    main()
