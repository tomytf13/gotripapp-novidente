const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");
const twilio = require("twilio"); // ✅ Nuevo: Twilio para enviar mensajes de emergencia
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const port = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

//app.use(cors());
app.use(express.json());

/** 🌟 SECCIÓN DE EMERGENCIAS: LLAMADA Y MENSAJE DE TEXTO 🌟 */

// 🔴 Definir el número de emergencia
const NUMERO_EMERGENCIA = "+5493816694178"; // Reemplázalo con el número real

// 🔴 Configurar Twilio para enviar SMS
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 📩 Ruta para enviar mensaje de emergencia
app.post("/enviar-emergencia", async (req, res) => {
    try {
        const { telefono, mensaje } = req.body;

        const response = await twilioClient.messages.create({
            body: mensaje,
            from: process.env.TWILIO_PHONE_NUMBER, // Número de Twilio
            to: telefono,
        });

        res.status(200).json({ success: true, message: "Mensaje de emergencia enviado", response });
    } catch (error) {
        console.error("❌ Error enviando mensaje de emergencia:", error);
        res.status(500).json({ success: false, error });
    }
});

// 📞 Ruta para manejar llamadas de emergencia (solo abre el marcador en frontend)
app.get("/llamar-emergencia", (req, res) => {
    res.json({ numero: NUMERO_EMERGENCIA });
});

/** 🌟 FIN DE SECCIÓN DE EMERGENCIAS 🌟 */

/** 🌍 SECCIÓN DE GEOPOSICIONAMIENTO Y RUTAS 🌍 */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let ubicacionActual = null;
let destinoFinal = null;
let rutaGenerada = null;
let indicePaso = 0;

// 🔹 Función para normalizar texto y detectar comandos de manera flexible
const normalizeTexto = (texto) => {
    return texto.toLowerCase()
        .normalize("NFD") // Elimina acentos
        .replace(/[\u0300-\u036f]/g, "") // Remueve caracteres diacríticos
        .trim();
};

// 🔹 Detectar destino con OpenAI
const detectarDestino = async (mensaje) => {
    try {
        const respuestaDestino = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [{
                role: "user",
                content: `Un usuario no vidente está buscando un destino turístico o una dirección en la ciudad de San Miguel de Tucumán, capital de la provincia de Tucumán, Argentina.
                
                El destino solicitado debe ser una ubicación válida dentro de la ciudad. Puede ser:
                - Una calle con numeración (Ejemplo: "Av. Sarmiento 800").
                - Una intersección de calles (Ejemplo: "Esquina de Av. Mitre y 24 de Septiembre").
                - Un lugar puntual conocido dentro de la ciudad (Ejemplo: "Plaza Urquiza", "Casa Histórica de Tucumán").
                - Coordenadas dentro de San Miguel de Tucumán.

                **⚠️ Importante:** Si el mensaje menciona un lugar fuera de San Miguel de Tucumán, o si el destino no es claro, responde exactamente con "NO_DESTINO".

                Mensaje: "${mensaje}"`
            }],
            max_tokens: 30,
        });

        return respuestaDestino.choices[0].message.content.trim() !== "NO_DESTINO"
            ? respuestaDestino.choices[0].message.content.trim()
            : null;
    } catch (error) {
        console.error("❌ Error detectando destino:", error);
        return null;
    }
};


// 🔹 Obtener coordenadas del destino con Google Maps
const obtenerCoordenadasDestino = async (nombreDestino) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(nombreDestino)},San+Miguel+de+Tucuman&key=${apiKey}`;

    try {
        const response = await axios.get(url);
        if (response.data.status === "OK" && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            return { latitud: location.lat, longitud: location.lng };
        }
    } catch (error) {
        console.error("❌ Error obteniendo coordenadas:", error);
        return null;
    }
};

// 🔹 Obtener ruta traducida
const obtenerRuta = async (ubicacionActual, destinoFinal) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${ubicacionActual.latitud},${ubicacionActual.longitud}&destination=${destinoFinal.latitud},${destinoFinal.longitud}&mode=walking&key=${apiKey}`;

    try {
        let response = await axios.get(url);
        if (response.data.status !== "OK" || response.data.routes.length === 0) {
            return ["No se encontró una ruta válida."];
        }

        const pasosEnIngles = response.data.routes[0].legs[0].steps.map(step => step.html_instructions.replace(/<[^>]*>?/gm, ''));

        const respuestaTraduccion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [{ role: "user", content: `Traduce estas instrucciones al español:\n${pasosEnIngles.join("\n")}` }],
            max_tokens: 300,
        });

        return respuestaTraduccion.choices[0].message.content.trim().split("\n");
    } catch (error) {
        console.error("❌ Error obteniendo ruta:", error);
        return ["No se pudo obtener la ruta."];
    }
};

// 📌 Evento para actualizar la ubicación en tiempo real
io.on("connection", (socket) => {
    console.log("🟢 Nuevo usuario conectado:", socket.id);

    socket.on("ubicacion", (data) => {
        ubicacionActual = data;
        console.log("📍 Ubicación actualizada:", ubicacionActual);
    });

    // 1️⃣ Detectar destino y generar ruta
    socket.on("encontrar_destino", async (data) => {
        const { mensaje } = data;
        console.log(`📩 Mensaje recibido: "${mensaje}"`);

        const posibleDestino = await detectarDestino(mensaje);
        if (!posibleDestino) {
            socket.emit("respuesta", { respuesta: "No pude encontrar el destino. ¿Podrías repetirlo?" });
            return;
        }

        console.log("📍 Destino detectado:", posibleDestino);
        const coordenadasDestino = await obtenerCoordenadasDestino(posibleDestino);
        if (!coordenadasDestino) {
            socket.emit("respuesta", { respuesta: "No se pudo encontrar la ubicación exacta del destino." });
            return;
        }

        destinoFinal = {
            nombre: posibleDestino,
            latitud: coordenadasDestino.latitud,
            longitud: coordenadasDestino.longitud
        };

        if (!ubicacionActual) {
            console.error("❌ No hay una ubicación válida del usuario.");
            socket.emit("respuesta", { respuesta: "Esperando tu ubicación... intenta nuevamente en unos segundos." });
            return;
        }

        console.log("📌 Ubicación actual utilizada:", ubicacionActual);

        // Generar ruta traducida
        rutaGenerada = await obtenerRuta(ubicacionActual, destinoFinal);
        if (!rutaGenerada || rutaGenerada.length === 0) {
            socket.emit("respuesta", { respuesta: "No se pudo generar una ruta válida. Verifica tu ubicación y destino." });
            return;
        }

        socket.emit("respuesta", {
            respuesta: `Destino encontrado: ${destinoFinal.nombre}. Puedes iniciar el recorrido.`,
            destino: destinoFinal,
            ruta: rutaGenerada
        });
    });

    // 🚨 Comando "siguiente paso"
    socket.on("siguiente_paso", () => {
        if (!rutaGenerada || indicePaso >= rutaGenerada.length - 1) {
            socket.emit("respuesta", { respuesta: "🏁 ¡Has llegado a tu destino!" });
            destinoFinal = null;
            rutaGenerada = null;
            indicePaso = 0;
            return;
        }

        indicePaso++;
        socket.emit("respuesta", { respuesta: `Siguiente paso: ${rutaGenerada[indicePaso]}` });
    });

    // 🚀 Comando "repetir paso"
socket.on("repetir_paso", () => {
    if (rutaGenerada && indicePaso < rutaGenerada.length) {
        socket.emit("respuesta", { respuesta: `Repetimos: ${rutaGenerada[indicePaso]}` });
    }
});

   // 🚀 Comando "detalles del destino" con reconocimiento más flexible
socket.on("detalles_destino", async () => {
    if (!destinoFinal) {
        socket.emit("respuesta", { respuesta: "Aún no has seleccionado un destino. Encuentra un destino primero." });
        return;
    }

    console.log(`❓ Usuario preguntó sobre el destino: ${destinoFinal.nombre}`);

    try {
        const respuestaIA = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "user", content: `Un usuario no vidente está visitando ${destinoFinal.nombre} en San Miguel de Tucumán.` },
                { role: "user", content: `Quiere saber más información sobre este lugar. 
                  Proporciónale una respuesta clara, interesante y útil.` }
            ],
            max_tokens: 1000,
        });

        socket.emit("respuesta", { respuesta: respuestaIA.choices[0].message.content.trim() });
    } catch (error) {
        console.error("❌ Error respondiendo sobre el destino:", error);
        socket.emit("respuesta", { respuesta: "No pude obtener información sobre el destino en este momento." });
    }
});

socket.on("comenzar_recorrido", () => {
    if (!rutaGenerada || rutaGenerada.length === 0) {
        socket.emit("respuesta", { respuesta: "No hay una ruta generada. Encuentra un destino primero." });
        return;
    }

    indicePaso = 0; // Reiniciamos el índice del paso
    socket.emit("respuesta", { respuesta: `El recorrido ha iniciado. Primer paso: ${rutaGenerada[indicePaso]}` });
});

    socket.on("disconnect", () => {
        console.log("🔴 Usuario desconectado:", socket.id);
    });
});

server.listen(port, () => {
    console.log(`✅ Servidor corriendo en puerto ${port}`);
});

