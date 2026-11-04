import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetSafeAreaInsets } from "./mocks/safe-area";
import { setKeyboardHeight } from "../src/native/keyboard.web";

afterEach(() => {
  cleanup();
  resetSafeAreaInsets();
  setKeyboardHeight(0);
});
