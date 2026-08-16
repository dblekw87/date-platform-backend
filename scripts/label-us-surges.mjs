import { readConfig } from "../src/config.mjs";
import { labelUsSurges } from "../src/pipeline/us-labels.mjs";

/**
 * Rebuilds us_surge_events by hand. The nightly pipeline runs the same function.
 *
 * Thresholds are arguments because the right cut is an open question. +50% is
 * the learning label; anything rarer has too few examples to learn from, and a
 * model that finds the +50% names finds the +500% ones inside them.
 *
 * Usage:
 *   npm run us:label
 *   npm run us:label -- --gain=1.0 --min-price=1
 */

const config = readConfig();

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));

  return found ? Number(found.slice(prefix.length)) : fallback;
}

const options = {
  gain: readArg("gain", 0.5),
  minDollarVolume: readArg("min-dollar-volume", 1_000_000),
  minPrice: readArg("min-price", 0.1)
};

console.log(`labelling gain>=${options.gain}, price>=${options.minPrice}, dollar volume>=${options.minDollarVolume}`);
console.log(`${await labelUsSurges(config, options)} events`);

process.exit(0);
