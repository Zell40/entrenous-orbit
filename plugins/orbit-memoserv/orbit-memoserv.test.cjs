const assert = require('assert');
const p = require('./orbit-memoserv.js');

const date = 'Oct 07 22:41:10 2026 CEST';

const enList = [
  'Memos for Alice:',
  'Number  Sender  Date/Time',
  '  1     Bob     ' + date,
  '* 2     Carol   ' + date,
];

const frList = [
  'Mémos pour Alice :',
  'Numéro  Expéditeur  Date/Heure',
  '  1     Bob          ' + date,
  '* 2     Carol        ' + date,
];

const en = p.parseList(enList);
assert.strictEqual(en.ok, true);
assert.strictEqual(en.rows.length, 2);
assert.deepStrictEqual(
  en.rows.map((r) => [r.id, r.unread, r.sender, r.when]),
  [[1, false, 'Bob', date], [2, true, 'Carol', date]],
);

const fr = p.parseList(frList);
assert.strictEqual(fr.rows.length, 2);
assert.strictEqual(fr.rows[1].unread, true);
assert.strictEqual(fr.rows[1].sender, 'Carol');

const tight = p.parseList([
  'Mémos pour Zell :',
  '* 1 Bob ' + date,
]);
assert.strictEqual(tight.rows.length, 1);
assert.strictEqual(tight.rows[0].unread, true);
assert.strictEqual(tight.rows[0].sender, 'Bob');
assert.strictEqual(tight.rows[0].id, 1);

const glued = p.parseList(['Mémos pour Zell :\r*1 Bob ' + date]);
assert.strictEqual(glued.rows.length, 1);
assert.strictEqual(glued.rows[0].sender, 'Bob');
assert.strictEqual(glued.sawHeader, true);

const empty = p.parseList(["Vous n'avez pas de mémo."]);
assert.strictEqual(empty.ok, true);
assert.strictEqual(empty.empty, true);
assert.strictEqual(empty.rows.length, 0);

const denied = p.parseList(['Accès refusé.']);
assert.strictEqual(denied.denied, true);

const read = p.parseRead([
  'Mémo 2 par Carol (' + date + ').',
  'Pour supprimer, tapez : \x02/msg Message DEL 2\x02',
  'Bonjour, ceci est le mémo',
]);
assert.strictEqual(read.length, 1);
assert.strictEqual(read[0].id, 2);
assert.strictEqual(read[0].sender, 'Carol');
assert.strictEqual(read[0].when, date);
assert.strictEqual(read[0].text, 'Bonjour, ceci est le mémo');

const readEn = p.parseRead([
  'Memo 2 from Carol (' + date + ').',
  'To delete, type: /msg MemoServ DEL 2',
  'Hello',
]);
assert.strictEqual(readEn[0].text, 'Hello');
assert.strictEqual(readEn[0].sender, 'Carol');

assert.deepStrictEqual(p.classifyNotice('Vous avez un nouveau mémo de Bob,'), { type: 'arrival', from: 'Bob' });
assert.deepStrictEqual(p.classifyNotice('You have a new memo from Bob.'), { type: 'arrival', from: 'Bob' });
assert.deepStrictEqual(p.classifyNotice('Vous avez 1 nouveau mémo.'), { type: 'count', n: 1 });
assert.deepStrictEqual(p.classifyNotice('You have 3 new memos.'), { type: 'count', n: 3 });
assert.strictEqual(p.classifyNotice('Vous avez un nouveau mémo de Bob,').type, 'arrival');
assert.deepStrictEqual(
  p.classifyNotice('Il y a un nouveau mémo sur le canal #Aide.chat.'),
  { type: 'channel', channel: '#Aide.chat' },
);
assert.strictEqual(p.isQuietNotice('Tapez /msg Message READ 3 pour le lire.'), true);
assert.strictEqual(p.isQuietNotice('Type /msg Message READ 3 to read it.'), true);
assert.strictEqual(p.looksError('Mémo envoyé à Bob.'), false);
assert.strictEqual(p.looksError("Bob n'est pas un pseudo ou canal enregistré qui n'est pas interdit."), true);
assert.strictEqual(p.stripIrc('Mémo envoyé à \x02Bob\x02.'), 'Mémo envoyé à Bob.');

const ig = p.parseIgnore(['Liste des ignorés :', 'BadNick', '*!*@evil.example']);
assert.deepStrictEqual(ig.masks, ['BadNick', '*!*@evil.example']);
const igEmpty = p.parseIgnore(['La liste des ignorés est vide.']);
assert.strictEqual(igEmpty.empty, true);
assert.strictEqual(igEmpty.masks.length, 0);

console.log('orbit-memoserv parse ok');
