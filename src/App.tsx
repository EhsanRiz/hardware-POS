import { useEffect, useState } from "react";
import { useAuth } from "./context/AuthContext";
import { isPaired, onPairingChange } from "./lib/device";
import Login from "./components/Login";
import PairRegister from "./components/PairRegister";
import POS from "./pages/POS";
import PrintPreview from "./components/PrintPreview";

export default function App() {
  const { user } = useAuth();
  // Pairing comes before sign-in: a device has to *be* a till before anyone can
  // use it as one, and the register token is what lets a sale taken during an
  // outage sync later. Asking for it after login would mean a cashier could
  // sign in on an unpaired tablet and find they cannot sell.
  const [paired, setPaired] = useState(isPaired());

  // Pairing can also be dropped from the sign-in screen ("Not this shop?"), so
  // this follows the device rather than only its own state.
  useEffect(() => onPairingChange(() => setPaired(isPaired())), []);

  if (!paired) {
    return (
      <>
        <PairRegister onPaired={() => setPaired(true)} />
        <PrintPreview />
      </>
    );
  }

  return (
    <>
      {user ? <POS /> : <Login />}
      <PrintPreview />
    </>
  );
}
