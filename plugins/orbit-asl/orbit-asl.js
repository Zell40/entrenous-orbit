/*
 * orbit-asl — profil âge / genre / ville sur l’écran de connexion Orbit.
 *
 * Le client désactive le bouton « Entrer » quand ce plugin est listé ET que
 * config.json pose des règles sous `"asl"`.
 *
 * config.json :
 *   "asl": {
 *     "requireAge": true,
 *     "requireGender": true,
 *     "requireCity": true,
 *     "minAge": 18
 *   }
 *   "plugins": ["/app/plugins/third/orbit-asl/orbit-asl.js?v=1"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;
  Orbit.plugin('orbit-asl', function (orbit, log) {
    var asl = (orbit.config() || {}).asl || {};
    log('asl ready', asl);
  });
})();
