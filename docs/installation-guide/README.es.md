# Guía de Instalación de Naia OS

Esta guía te guiará paso a paso para instalar Naia OS desde una unidad USB en vivo.

## Requisitos previos

- Una unidad USB (de 8 GB o más) flasheada con la ISO de Naia OS
- Un ordenador con soporte de arranque UEFI
- Al menos 64 GB de espacio libre en el disco
- Conexión a Internet (recomendada, para la sincronización de la hora)

## Arrancar desde el USB

1. Inserta la unidad USB de Naia OS en tu ordenador.
2. Reinicia e ingresa al menú de arranque de tu BIOS/UEFI (usualmente `F12`, `F2`, o `Del` durante el inicio).
3. Selecciona la unidad USB como dispositivo de arranque.
4. El entorno en vivo de Naia OS se cargará automáticamente.

## Iniciar el Instalador

Desde el escritorio en vivo, haz doble clic en **Install to Hard Drive** (Instalar en el Disco Duro) o encuéntralo en el menú de aplicaciones.

El instalador Anaconda se abrirá en tu navegador con el asistente de **Naia OS 0.1.0 (Bazzite) installation**.

## Paso 1: Bienvenida — Idioma y Teclado

![Pantalla de bienvenida](images/01-welcome.png)

- **Language** (Idioma): Selecciona tu idioma preferido de la lista. Usa la caja de búsqueda para encontrarlo rápidamente.
- **Keyboard** (Teclado): Elige la distribución de tu teclado. El inglés (US) está seleccionado por defecto.
- Haz clic en **Next** (Siguiente) para continuar.

## Paso 2: Fecha y Hora

![Fecha y hora](images/02-datetime.png)

- **Date and time** (Fecha y hora): Configurado automáticamente mediante servidores NTP por defecto.
- **Timezone** (Zona horaria): Detectada automáticamente según tu ubicación. Cambia la región y ciudad si es necesario.
- Haz clic en **Next** (Siguiente) para continuar.

## Paso 3: Método de Instalación

![Método de instalación](images/03-installation-method.png)

- **Destination** (Destino): Muestra el disco detectado (ej. "Virtio Block Device (vda) 64.4 GB disk"). Haz clic en "Change destination" si necesitas seleccionar una unidad diferente.
- **How would you like to install?** (¿Cómo te gustaría instalar?): "Use entire disk" (Usar todo el disco) es la opción recomendada. Esto borrará todos los datos existentes en el disco seleccionado.
- Haz clic en **Next** (Siguiente) para continuar.

> **Advertencia**: "Use entire disk" eliminará todas las particiones y datos de la unidad seleccionada. Asegúrate de haber respaldado cualquier dato importante.

## Paso 4: Configuración de Almacenamiento

![Configuración de almacenamiento](images/04-storage.png)

- **Encryption** (Cifrado): Opcionalmente marca "Encrypt my data" para habilitar el cifrado del disco con LUKS. Se te pedirá que establezcas una frase de contraseña.
- Para la mayoría de los usuarios, dejar el cifrado sin marcar está bien.
- Haz clic en **Next** (Siguiente) para continuar.

## Paso 5: Crear Cuenta

![Crear cuenta](images/05-create-account.png)

- **Full name** (Nombre completo): Ingresa tu nombre para mostrar.
- **User name** (Nombre de usuario, requerido): Tu nombre de usuario para iniciar sesión. Generado automáticamente a partir de tu nombre completo.
- **Passphrase** (Frase de contraseña, requerida): Debe tener al menos 6 caracteres.
- **Confirm passphrase** (Confirmar frase de contraseña): Vuelve a ingresar la misma frase.
- **Enable root account** (Habilitar cuenta root): Déjalo desmarcado a menos que tengas una necesidad específica de iniciar sesión como root.
- Haz clic en **Next** (Siguiente) para continuar.

## Paso 6: Revisar e Instalar

![Revisar e instalar](images/06-review.png)

Revisa tus configuraciones de instalación:

- **Operating system** (Sistema operativo): Naia OS 0.1.0 (Bazzite)
- **Language** (Idioma): El idioma seleccionado
- **Timezone** (Zona horaria): Tu zona horaria seleccionada
- **Account** (Cuenta): Tu nombre de usuario
- **Installation type** (Tipo de instalación): Usar todo el disco
- **Storage** (Almacenamiento): Diseño de particiones (EFI, boot, root, home)

Si todo se ve correcto, haz clic en **Erase data and install** (Borrar datos e instalar) para comenzar la instalación.

## Progreso de la Instalación

![Instalando](images/07-installing.png)

El instalador pasará por cuatro etapas:

1. **Storage configuration** — Particionado y formateo del disco
2. **Software installation** — Copia del sistema operativo al disco
3. **System configuration** — Configuración de usuarios, zona horaria y otros ajustes
4. **Finalization** — Limpieza final e instalación del gestor de arranque

![Instalación en progreso](images/08-installing-progress.png)

Este proceso generalmente toma entre 10 y 20 minutos, dependiendo de tu hardware.

## Instalación Completa

Una vez que termine la instalación, verás una pantalla de finalización. Haz clic en **Reboot** (Reiniciar) para reiniciar tu ordenador.

> Retira la unidad USB antes de que el sistema se reinicie para arrancar desde el disco instalado.

## Primer Arranque

Después de reiniciar, Naia OS arrancará desde tu disco duro. Inicia sesión con el nombre de usuario y la frase de contraseña que creaste durante la instalación.

¡Bienvenido a Naia OS!