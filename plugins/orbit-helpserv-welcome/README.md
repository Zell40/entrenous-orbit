# orbit-helpserv-welcome

Affiche un message d’accueil (faux PRIVMSG locaux) dès qu’un utilisateur ouvre un PV avec **AideMoi** ou **SignalMoi**.

- **AideMoi** : bonjour + liens d’aide  
- **SignalMoi** : bonjour + rappel que le bot traite le suivi dès le premier message réel (pas de commande REPORT côté client)

Le bouton **Signaler** du profil (whois) utilise `config.report.query` (`SignalMoi`) :
ouverture du PV + brouillon naturel `Je souhaiterais vous signaler <pseudo> : motif ?` + accueil automatique.

Aucun trafic IRC pour l’accueil. Les tickets restent gérés par HelpServ Anope.
