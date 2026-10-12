/* Showdown Tactician - lib/mlp-residual.js
 * GENERATED FILE - do not edit by hand; regenerate with
 *   node tools/train_mlp_residual.js --input training_data.json
 * The trained residual head for the frozen 128D linear evaluator. This module is the DATA
 * half only; the network and the clamp live in src/mlp_residual.js and the reviewable
 * artifact (with the hold-out AUCs and the paired bootstrap) is lib/mlp-residual.json.
 *
 * The gate did NOT pass on the corpus this was last run against, so the payload below is null:
 * a rejected head costs the content script nothing and cannot be switched on by a stray
 * config edit. Re-run the tool on a better corpus to regenerate it.
 * Gate: AUC 0.7145 base -> 0.7144 hybrid on the battle-level hold-out, paired bootstrap 95% CI [-0.0011, 0.0009].
 */
(function () {
  "use strict";
  window.ST = window.ST || {};
  window.ST.MLP_RESIDUAL = null;
})();
