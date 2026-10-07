# orbit-memoserv

Boîte **Mémos** dans Orbit, branchée sur MemoServ Anope. Sur Entre Nous le pseudo du service est **Message**.

L’expéditeur et le destinataire (ou le salon) doivent être enregistrés. Le mémo part que la personne soit en ligne ou non. Si elle est identifiée et que les notifications sont actives, Message la prévient.

## Dans l’interface

Une ligne **Mémos** en haut de la liste des salons (pastille si non lu).

| Action | Commande envoyée |
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

Les notices de Message (nouveau mémo, liste, lecture) ne s’affichent pas dans le salon en cours : elles alimentent cette boîte. Un nouveau mémo prévient aussi par notification.

## Config

```json
"memoserv": { "service": "Message" },
"plugins": ["/app/plugins/third/orbit-memoserv/orbit-memoserv.js?v=1"]
```

Incrémenter `?v=` après une modification du JS. Le client Orbit doit lister `orbit-memoserv` parmi les panneaux de la colonne centrale (même traitement que la liste blanche).
