"""Build public/five-a-sold/index.html from template.html, engine.js and data.json.

    python3 tools/five-a-sold/build.py
data.json holds the players, managers (with portraits) and commentary; engine.js is the auction and match engine.
"""
import pathlib
root = pathlib.Path(__file__).resolve().parents[2]
here = pathlib.Path(__file__).parent
t = (here / 'template.html').read_text(encoding='utf-8')
e = (here / 'engine.js').read_text(encoding='utf-8')
d = (here / 'data.json').read_text(encoding='utf-8').replace('</', '<\\/')
assert t.count('__DATA__') == 1 and t.count('__ENGINE__') == 1
page = t.replace('__DATA__', d).replace('__ENGINE__', e)
head = ('<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="description" content="Bid for a five-a-side squad against a famous manager, then watch the highlights in 90s text commentary.">'
        '<meta name="theme-color" content="#1d4a2d"></head><body>\n')
out = root / 'public/five-a-sold/index.html'
out.write_text(head + page + '\n</body></html>\n', encoding='utf-8')
print('wrote', out, len(page) // 1024, 'KB')
