// Configuración pública de la app. Nada de aquí es secreto:
// la seguridad la hace Apps Script validando el token de sesión en cada llamada.
export const CONFIG = {
  // URL del Web App de Apps Script (termina en /exec). Se llena al desplegar el script.
  API_URL: 'https://script.google.com/macros/s/AKfycbxG483KPkUhdWk9npDFm3gq_7kupxP5oz6e6NkkgDVBymi6sXsJVj6RfOPUql-kQW1o1A/exec',

  firebase: {
    apiKey: 'AIzaSyAsfJqMplaZtDDEX_rBIwNsU6eTfd2cks4',
    authDomain: 'flotilla-packatelas.firebaseapp.com',
    projectId: 'flotilla-packatelas',
    storageBucket: 'flotilla-packatelas.firebasestorage.app',
    messagingSenderId: '361944784904',
    appId: '1:361944784904:web:f7edcf16bec97f0dd8f1bd',
  },
  vapidKey: 'BPVwlscU-k9y2rQmjnhiu_p1xeGSTHfP5n-C8SREKdjAWvn4tiYMKL5CSx0-dbIlkDMVRDDfoGJxXJxoH8fjZyM',

  // Contenido del QR de cada moto: QR_PREFIX + vehiculo_id  (ej. "FLOTILLA:M-01")
  QR_PREFIX: 'FLOTILLA:',
};
