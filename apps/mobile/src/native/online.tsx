/**
 * Whether this phone is online at all, apart from whether its computer is:
 * offline, nothing can reach the relay, and the app says so above everything
 * instead of letting each screen fail on its own.
 */
import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

export function useDeviceOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(
    () =>
      NetInfo.addEventListener((s) => {
        // Unknown reachability counts as online: a captive check that has not run yet is not an outage.
        setOnline(s.isConnected !== false && s.isInternetReachable !== false);
      }),
    [],
  );
  return online;
}
