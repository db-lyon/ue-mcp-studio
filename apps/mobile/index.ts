// The WebCrypto shim must be in place before the remote protocol package loads.
import "./src/webcrypto";
import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
