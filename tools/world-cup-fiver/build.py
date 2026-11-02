"""Build public/world-cup-fiver/index.html from template.html, engine.js, cards.csv and commentary.json.

    python3 tools/world-cup-fiver/build.py
cards.csv is the locked master deck (one row per player per tournament). The page carries every nation's cards inline.
"""
import csv, json, pathlib, datetime
root = pathlib.Path(__file__).resolve().parents[2]
here = pathlib.Path(__file__).parent
OUT = ['Fin', 'Pas', 'Dri', 'Pac', 'Def', 'Phy', 'Wrk', 'Com']
# nickname and kit (shirt, trim, text on shirt) per nation. Perks and style lines come in the next step.
META = {
 'Argentina': ('La Albiceleste', '#75AADB', '#FFFFFF', '#0B2545'), 'Australia': ('Socceroos', '#FFCD00', '#00843D', '#00483A'),
 'Belgium': ('Red Devils', '#C8102E', '#000000', '#FFFFFF'), 'Brazil': ('Seleção', '#FEDD00', '#009C3B', '#00532A'),
 'Cameroon': ('Indomitable Lions', '#007A5E', '#CE1126', '#FFFFFF'), 'Colombia': ('Los Cafeteros', '#FCD116', '#003893', '#003893'),
 'Croatia': ('Vatreni', '#E3111B', '#FFFFFF', '#FFFFFF'), 'Denmark': ('Danish Dynamite', '#C8102E', '#FFFFFF', '#FFFFFF'),
 'England': ('Three Lions', '#FFFFFF', '#C8102E', '#14245E'), 'France': ('Les Bleus', '#0055A4', '#FFFFFF', '#FFFFFF'),
 'Germany': ('Die Mannschaft', '#F4F4F4', '#111111', '#111111'), 'Iran': ('Team Melli', '#C8102E', '#239F40', '#FFFFFF'),
 'Ireland': ('Boys in Green', '#169B62', '#FFFFFF', '#FFFFFF'), 'Italy': ('Azzurri', '#0066B3', '#FFFFFF', '#FFFFFF'),
 'Japan': ('Samurai Blue', '#0B3A8C', '#FFFFFF', '#FFFFFF'), 'Mexico': ('El Tri', '#006847', '#CE1126', '#FFFFFF'),
 'Morocco': ('Atlas Lions', '#C1272D', '#006233', '#FFFFFF'), 'Netherlands': ('Oranje', '#FF6600', '#FFFFFF', '#101010'),
 'Nigeria': ('Super Eagles', '#008751', '#FFFFFF', '#FFFFFF'), 'Norway': ('Landslaget', '#BA0C2F', '#00205B', '#FFFFFF'),
 'Portugal': ('A Seleção das Quinas', '#C8102E', '#006600', '#FFFFFF'),
 'Saudi Arabia': ('Green Falcons', '#006C35', '#FFFFFF', '#FFFFFF'), 'Scotland': ('Tartan Army', '#0B1F5C', '#FFFFFF', '#FFFFFF'),
 'Serbia': ('Orlovi', '#C6363C', '#FFFFFF', '#FFFFFF'), 'South Korea': ('Taegeuk Warriors', '#CD2E3A', '#0047A0', '#FFFFFF'),
 'Spain': ('La Roja', '#C60B1E', '#FFC400', '#FFC400'), 'Sweden': ('Blågult', '#FECC00', '#006AA7', '#006AA7'),
 'Switzerland': ('Nati', '#D52B1E', '#FFFFFF', '#FFFFFF'), 'Tunisia': ('Eagles of Carthage', '#E70013', '#FFFFFF', '#FFFFFF'),
 'USA': ('Stars and Stripes', '#0A3161', '#B31942', '#FFFFFF'), 'Uruguay': ('La Celeste', '#55B5E5', '#000000', '#0B1F3A'),
 'Wales': ('The Dragons', '#C8102E', '#FFFFFF', '#FFFFFF'),
}
# tournament start dates, for each card's age at that World Cup
START = {1950: '1950-06-24', 1954: '1954-06-16', 1958: '1958-06-08', 1962: '1962-05-30', 1966: '1966-07-11', 1970: '1970-05-31', 1974: '1974-06-13',
         1978: '1978-06-01', 1982: '1982-06-13', 1986: '1986-05-31', 1990: '1990-06-08', 1994: '1994-06-17', 1998: '1998-06-10', 2002: '2002-05-31',
         2006: '2006-06-09', 2010: '2010-06-11', 2014: '2014-06-12', 2018: '2018-06-14', 2022: '2022-11-20', 2026: '2026-06-11'}
def age(dob, y, club=''):
    import re
    if dob and not str(y).isdigit():  # non-World Cup legends: age at the start of the season named in the club, e.g. "Liverpool (1986-87)"
        m = re.search(r'\((\d{4})-\d{2}\)', club)
        if m: START[y] = m.group(1) + '-09-01'; y_key = y
        else: return None
    elif not dob or not str(y).isdigit() or int(y) not in START: return None
    key = y if not str(y).isdigit() else int(y)
    d, m, yy = (int(x) for x in dob.split('/')) if '/' in dob else reversed([int(x) for x in dob.split('-')])
    s = datetime.date.fromisoformat(START[key]); b = datetime.date(yy, m, d)
    return s.year - b.year - ((s.month, s.day) < (b.month, b.day))
nations = {}
for r in csv.DictReader(open(here / 'cards.csv', encoding='utf-8')):
    a = [int(x) for x in r['Fin Pas Dri Pac Def Phy Wrk Com (GK: Sho Pos Dis Com)'].split()]
    caps = int(r['caps']) if str(r['caps']).strip().isdigit() else None
    y = r['tournament']
    nations.setdefault(r['nation'], []).append([r['name'], r['pos'], r['secondary'], r['club'], int(y) if y.isdigit() else y, caps, 1 if r['legend'] == 'Y' else 0, int(r['rating']), a, age(r.get('dob', ''), y, r['club'])])
assert set(nations) == set(META), set(nations) ^ set(META)
# person id per nation: two cards are the same person when they share a date of birth and the names agree:
# one name contains the other, or the first names match, or the surnames match and the first names start alike
# (catches "Patrick Mboma"/"Patrick M'Boma", "Cammy"/"Cameron Devlin"; keeps twins such as Frank and Ronald de Boer apart,
# and two different "Fred"s apart because their dates differ)
import unicodedata
def toks(n):
    n = unicodedata.normalize('NFKD', n).encode('ascii', 'ignore').decode().lower().replace("'", '')
    return [t for t in n.replace('-', ' ').split() if len(t) >= 2]
def same(a, b):
    ta, tb = toks(a), toks(b)
    if not ta or not tb: return False
    if set(ta) <= set(tb) or set(tb) <= set(ta) or ta[0] == tb[0]: return True
    return ta[-1] == tb[-1] and ta[0][:3] == tb[0][:3]
dobs = {}
for r in csv.DictReader(open(here / 'cards.csv', encoding='utf-8')):
    dobs[(r['nation'], r['name'], r['tournament'])] = r.get('dob', '')
merged = 0
for nat, cards in nations.items():
    groups = []  # [dob, names, pid]
    for c in cards:
        dob, pid = dobs.get((nat, c[0], str(c[4])), ''), None
        for g in groups:
            if c[0] in g[1] and (not dob or not g[0] or g[0] == dob): pid = g[2]; break
            if dob and g[0] == dob and any(same(c[0], x) for x in g[1]): pid = g[2]; break
        if pid is None: pid = len(groups); groups.append([dob, {c[0]}, pid])
        else:
            if c[0] not in groups[pid][1]: merged += 1
            groups[pid][1].add(c[0])
        c.append(pid)
print('cards merged under another spelling:', merged)
data = {'perks': json.loads((here / 'perks.json').read_text(encoding='utf-8')), 'commentary': json.loads((here / 'commentary.json').read_text(encoding='utf-8')),
        'nations': {n: {'nick': META[n][0], 'kit': META[n][1:], 'cards': c} for n, c in sorted(nations.items())}}
t = (here / 'template.html').read_text(encoding='utf-8')
e = (here / 'engine.js').read_text(encoding='utf-8')
d = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
assert t.count('__DATA__') == 1 and t.count('__ENGINE__') == 1
import base64
trophy = 'data:image/png;base64,' + base64.b64encode((here / 'trophy.png').read_bytes()).decode()
import glob, os
NATS = {'baggio': ['Italy'], 'gascoigne': ['England'], 'maradona': ['Argentina'], 'eusebio': ['Portugal'], 'beckham': ['England'], 'batty': ['England'], 'baresi': ['Italy'], 'di_biagio': ['Italy'], 'zidane': ['France'], 'ronaldo_2006': ['Portugal'], 'ronaldo_nazario': ['Brazil'], 'gyan': ['Ghana'], 'messi': ['Argentina'], 'david_luiz': ['Brazil'], 'neymar': ['Brazil']}
ko = []
for f in sorted(glob.glob(str(here / 'ko' / '*.png'))):
    key = [k for k in NATS if os.path.basename(f)[3:-4].startswith(k)]
    key = max(key, key=len)
    ko.append({'nat': NATS[key], 'src': 'data:image/png;base64,' + base64.b64encode(open(f, 'rb').read()).decode()})
page = t.replace('__KO__', json.dumps(ko)).replace('__DATA__', d).replace('__ENGINE__', e).replace('__TROPHY__', trophy)
head = ('<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="robots" content="noindex">'
        '<meta name="description" content="Pick a nation, draft a five-a-side squad from its World Cup history, then play.">'
        '<meta name="theme-color" content="#1d4a2d"></head><body>\n')
out = root / 'public/world-cup-fiver/index.html'
out.write_text(head + page + '\n</body></html>\n', encoding='utf-8')
print('wrote', out, len(page) // 1024, 'KB', sum(len(v) for v in nations.values()), 'cards')
