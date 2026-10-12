# Flotilla Packatelas

App web instalable (PWA) para la flotilla de motos de Packatelas: check matutino con fotos y km, carga de gasolina, reporte de daños antes de ruta, reparaciones del mecánico con reparto de costos, documentos con vigencias y métricas.

Sin servidor propio:

| Pieza | Dónde vive |
|---|---|
| App (HTML/JS) | GitHub Pages: `https://computenga.github.io/flotilla-packatelas/` |
| API | Google Apps Script (Web App), código en `apps-script/` |
| Datos | Google Sheets "Flotilla Packatelas · Base de datos" |
| Fotos y evidencias | Google Drive, carpeta "Flotilla Packatelas App" |
| Notificaciones push | Firebase Cloud Messaging, proyecto `flotilla-packatelas` |

## Roles

- **Repartidor**: check matutino (4 fotos, odómetro, km, fallas), carga de gasolina ligada a ese check, reporte opcional antes de ruta, historial de sus fallas y cargos.
- **Mecánico**: bandeja de fallas, comparación con las fotos del check matutino, inicio y cierre de reparación con costos y quién paga, documentos de las motos.
- **Admin**: métricas, todo lo del mecánico, su propia jornada (por si también reparte), PIN de usuarios y etiquetas QR.

## Reglas de negocio

- Quien hace el check matutino es quien trajo la moto desde el día anterior: los km recorridos desde el último check de esa moto (incluidos traslados casa-trabajo) y las fallas encontradas se le asignan a él.
- Los km no pueden ser menores al último registro de la moto.
- Una carga de gasolina por check matutino, del mismo repartidor y moto.
- Un daño reportado "antes de ruta" queda como **no reportado** y se atribuye a quien hizo el último check matutino de esa moto. El mecánico confirma si se ve en las fotos de la mañana.
- Al cerrar una reparación: desgaste = paga la empresa; mal uso = paga el empleado; acuerdo = se reparte con el monto que se capture. Si hay cargo, el repartidor recibe un aviso.

## Instalación del backend (una sola vez)

1. Entra a <https://script.google.com> con **cguevara@computenga.com** → *Nuevo proyecto* → nómbralo "Flotilla Packatelas API".
2. *Configuración del proyecto* → activa **Mostrar el archivo de manifiesto "appsscript.json"**.
3. Copia `apps-script/Code.gs` y `apps-script/appsscript.json` en el editor (reemplaza el contenido).
4. Liga el script al proyecto de Google Cloud de Firebase para que pueda mandar push:
   - En <https://console.cloud.google.com/apis/credentials/consent?project=flotilla-packatelas> configura la pantalla de consentimiento como **Interna**.
   - En Apps Script → *Configuración del proyecto* → *Proyecto de Google Cloud* → *Cambiar proyecto* → número de proyecto **361944784904**.
5. *Implementar* → *Nueva implementación* → tipo **Aplicación web** → ejecutar como **Yo**, acceso **Cualquier usuario** → autoriza los permisos.
6. Copia la URL que termina en `/exec` y pégala en `js/config.js` (`API_URL`), en el repo.
7. En el editor, cambia usuario y PIN en `asignarPinManual()` y ejecútala para darte acceso como admin. Los demás PIN se asignan desde la app (Más → Usuarios y PIN).
8. Ejecuta `instalarTriggers()` una vez para crear las tareas diarias.

Cada vez que cambie `Code.gs`: *Implementar* → *Administrar implementaciones* → editar → **Nueva versión** (la URL no cambia).

## Datos iniciales en la hoja

- **Usuarios**: `usuario_id` (U-001…), nombre, rol (`repartidor` / `mecanico` / `admin`), correo, `activo` = SI. Deja `pin_hash` vacío.
- **Vehiculos**: `vehiculo_id` (M-01…), placa, marca, modelo, `km_actual`, `estatus` = activo.
- **Config**: `CORREOS_ADMIN` y `CORREO_MECANICO`.

Después imprime las etiquetas QR desde la app (Más → Imprimir etiquetas QR) y pégalas en cada moto.

## Tareas programadas

| Tarea | Cuándo | Qué hace |
|---|---|---|
| `tareaDocumentos` | Diario 8:00 | Push y correo a mecánico y admins a 30, 15 y 7 días del vencimiento y al vencer |
| `tareaPendientesCarga` | Diario a la `HORA_LIMITE_CHECK` | Avisa al admin qué checks de hoy no tienen carga de gasolina |
| `tareaFallasSinAtender` | Cada 2 h | Recuerda al mecánico las fallas abiertas por más de `HORAS_FALLA_SIN_ATENDER` |
| `tareaResumenSemanal` | Lunes 8:00 | Correo a admins con costos y tiempos de la semana anterior |

## Notificaciones

Cada usuario las activa en su teléfono desde la app. En iPhone solo funcionan si la app está agregada a la pantalla de inicio (iOS 16.4 o posterior). Si un usuario no tiene notificaciones activas, el aviso le llega por correo (excepto el aviso de cargo al repartidor, que solo es push).

## Sin señal

La app abre sin conexión. Los checks, cargas y reportes se guardan en el teléfono y se envían solos al recuperar señal; las fotos que ya se subieron no se vuelven a subir.
