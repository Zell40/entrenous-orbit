# orbit-helpserv-welcome

Affiche un message d’accueil (faux PRIVMSG locaux) dès qu’un utilisateur ouvre un PV avec **AideMoi** ou **SignalMoi**.

- **AideMoi** : bonjour + liens d’aide  
- **SignalMoi** : intervention rapide + rappel REPORT  

Le bouton **Signaler** du profil (whois) utilise `config.report.query` (`SignalMoi`) : ouverture du PV + brouillon `REPORT pseudo [#salon] ` + accueil automatique.

Aucun trafic IRC pour l’accueil. Les tickets restent gérés par HelpServ Anope.

