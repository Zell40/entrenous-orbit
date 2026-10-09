# orbit-memoserv

Boîte **Mémos** dans Orbit, branchée sur MemoServ Anope. Sur Entre Nous le pseudo du service est **Message**.

L’expéditeur et le destinataire (ou le salon) doivent être enregistrés. Le mémo part que la personne soit en ligne ou non. Si elle est identifiée et que les notifications sont actives, Message la prévient.

Les commandes passent par **JSON-RPC Anope** (`memoserv-rpc.php`). Le navigateur ne parle pas à Anope : le PHP appelle `anope.identify` puis `anope.command` au nom du compte. L’adresse et le jeton sont dans `memoserv-rpc.local.php` (jamais commité, pas écrasé au déploiement), les mêmes que ChanServ. Sans ce fichier, la liste ne boucle plus : le panneau indique que le RPC n’est pas configuré.

Un mémo qui arrive est toujours une notice de Message (masquée du salon) ; la liste est alors relue via RPC.

## Dans l’interface

Un onglet **Mémo** dans le menu du bas (pastille si non lu). Il ouvre un panneau : reçus, lecture, écriture, ignorés. Le salon en cours reste affiché.

Dans « Écrire », le destinataire se complète dès la première lettre : pseudos **en ligne et identifiés** (`anope.listUsers`), ou, si le texte commence par `#`, salons **enregistrés** (`ChanServ LIST`, sans le `#`).

| Action | Commande RPC |
| --- | --- |
| Ouvrir / actualiser | `LIST` |
| Lire | `READ numéro` |
| Envoyer | `SEND pseudo texte` |
| Accusé de lecture | `RSEND pseudo texte` |
| Supprimer | `DEL numéro` |
| Dernier mémo déjà lu ? | `CHECK pseudo` |
| Annuler le dernier (s’il n’est pas lu) | `CANCEL pseudo` |
| Ignorer | `IGNORE ADD` / `DEL` / `LIST` |

Le menu d’un pseudo et sa fiche proposent **Envoyer un mémo**. `/memo` ouvre la boîte, `/memo Pseudo texte` envoie.

`SENDALL` et `STAFF` ne sont pas dans le panneau (opérateurs).

Les avis « nouveau mémo » de Message ne s’affichent pas dans le salon : ils mettent à jour la boîte et peuvent envoyer une notification. La liste, la lecture et l’envoi passent par le RPC.

## Config

```json
"memoserv": { "service": "Message" },
"plugins": ["/app/plugins/third/orbit-memoserv/orbit-memoserv.js?v=8"]
```

Incrémenter `?v=` après une modification du JS. Le panneau est un overlay du menu du bas, pas une fausse conversation.
