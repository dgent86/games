"""Build public/streaker/index.html from template.html and data.json.

    python3 tools/streaker/build.py            # site build, leaderboard on (uses this site's /api)
    python3 tools/streaker/build.py --out X --lb ''   # standalone copy with the leaderboard switched off
"""
import argparse, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument('--out', default=str(root / 'public/streaker/index.html'))
ap.add_argument('--lb', default='/api')
a = ap.parse_args()
here = pathlib.Path(__file__).parent
t = (here / 'template.html').read_text(encoding='utf-8')
d = (here / 'data.json').read_text(encoding='utf-8')
assert t.count('__DATA__') == 1
page = t.replace('__LB_URL__', a.lb).replace('__LB_KEY__', '').replace('__DATA__', d)
head = ('<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="description" content="Name a footballer who fits all three cards. How long can your streak last?">'
        '<meta name="theme-color" content="#0f3a27"></head><body>\n')
pathlib.Path(a.out).write_text(head + page + '\n</body></html>\n', encoding='utf-8')
print('wrote', a.out, len(page) // 1024, 'KB')
