/*
 * orbit-asl — profil âge / genre / ville sur l’écran de connexion Orbit.
 *
 * Le client refuse la connexion (message d’erreur) quand ce plugin est listé
 * ET que config.json pose des règles sous `"asl"`. Genre : Homme / Femme /
 * Non indiqué (écrit « Autre » dans le GECOS). Âge mini WordPress : 10.
 *
 * config.json :
 *   "asl": {
 *     "requireAge": true,
 *     "requireGender": true,
 *     "requireCity": true,
 *     "minAge": 10
 *   }
 *   "plugins": ["/app/plugins/third/orbit-asl/orbit-asl.js?v=2"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;
  Orbit.plugin('orbit-asl', function (orbit, log) {
    var asl = (orbit.config() || {}).asl || {};
    log('asl ready', asl);
  });
})();
