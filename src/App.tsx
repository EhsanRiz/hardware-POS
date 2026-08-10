import { useAuth } from "./context/AuthContext";
import Login from "./components/Login";
import POS from "./pages/POS";
import PrintPreview from "./components/PrintPreview";

export default function App() {
  const { user } = useAuth();
  return (
    <>
      {user ? <POS /> : <Login />}
      <PrintPreview />
    </>
  );
}
