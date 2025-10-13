import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";        // your file (the code you pasted)
import "./index.css";               // keep this line (can be empty)

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />                         {/* default export from your file */}
  </React.StrictMode>
);