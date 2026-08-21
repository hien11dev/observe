import { Logger } from "@nestjs/common";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";

export function assertModuleOptions(
  options: ObserveModuleOptionsWithDefaults | undefined,
): asserts options is ObserveModuleOptionsWithDefaults {
  if (!options) {
    const errorMessage = `ObserveModule initialized without options. Ensure that you used the "forRoot" method to configure the module, as follows: "ObserveModule.forRoot()".`;
    Logger.error(errorMessage);
    throw new Error(errorMessage);
  }
}
