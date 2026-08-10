import { useState } from "react";
import { useAuth } from "./context/AuthContext";
import { isPaired } from "./lib/device";
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
