import { After, Before, Status, defineStep, setWorldConstructor } from "@cucumber/cucumber";

import { BehaviorWorld } from "../support/world.js";

setWorldConstructor(BehaviorWorld);

Before<BehaviorWorld>(function ({ pickle }) {
  this.begin(pickle.name);
});

defineStep<BehaviorWorld>(/^(.+)$/u, async function (text: string) {
  await this.execute(text);
});

After<BehaviorWorld>(function ({ result }) {
  this.finish(result?.status === Status.PASSED);
});
