# Rolplay Reborn — Balance de sobres y rarezas

## Sistema global

Todos los niveles 1–50 usan el mismo motor de obtención. Los sobres tienen un nivel seleccionable y el jugador solo puede comprar sobres de nivel igual o inferior a su propio nivel.

Un sobre de Nivel N:
- contiene 5 cartas;
- nunca contiene una carta de nivel superior a N;
- puede contener cartas antiguas;
- favorece fuertemente cartas cercanas a N;
- excluye el Poder básico de Nivel 1 porque es infinito.

## Peso de rareza y límite legendario

Para los sobres de Nivel 2 en adelante, la rareza modifica el peso base de cada carta:

- Común: ×1,00
- Poco común: ×0,75
- Rara: ×0,48
- Épica: ×0,22

Las legendarias se separan del resto del sorteo y reciben una **masa total máxima del 0,2% por extracción**. Ese 0,2% se reparte entre todas las legendarias elegibles según cercanía de nivel y eficiencia.

Así evitamos dos problemas: que un sobre alto se llene de comunes antiquísimas solo para cumplir una cuota fija, y que un nivel con muchas cartas históricamente poderosas dispare accidentalmente la frecuencia legendaria.

## Peso por nivel

Dentro de cada rareza se usa:

`afinidad = exp(-0,55 × (nivel del sobre - nivel de la carta))`

Una carta del mismo nivel del sobre tiene peso 1,00; una de un nivel inferior ~0,58; dos niveles inferior ~0,33; tres niveles inferior ~0,19. Esto evita que los sobres altos se llenen de cartas muy antiguas.

## Ajuste de fuerza y utilidad

Además de la rareza histórica se calcula un índice de utilidad que considera:
- ataque;
- defensa;
- coste de Poder/mana;
- si es criatura, Poder o habilidad;
- multiplicadores `x N` de cartas especiales;
- eficiencia relativa frente a cartas del mismo rol y niveles cercanos.

Dentro de una misma rareza, una carta más eficiente recibe un pequeño castigo de probabilidad. No basta con tener el mismo color de rareza: las cartas más fuertes son ligeramente más difíciles de obtener.

## Detección de legendarias

La categoría legendaria no se asigna solo por un número histórico. Se exige rareza histórica muy alta y rendimiento excepcional frente a cartas del mismo rol en una ventana de ±2 niveles.

Reglas actuales:
- rareza 100 + percentil de utilidad >= 60%;
- o rareza 99 + percentil >= 90%;
- o rareza >= 95 + percentil >= 98%;
- o Poder histórico de rareza 100 con multiplicador >= x15.

Esto deja 35 cartas legendarias de 285.

- Nivel 9: Mujer Aguila
- Nivel 14: Korth
- Nivel 17: Poder x 8 Mayor
- Nivel 20: Poder Mental x 4, Argnathor Poderal, Urgul Mayor, Angel Caido
- Nivel 22: Poder x 12 Mayor
- Nivel 25: Enher, Argnathor Ametal, Poder x 15 Domica, Poder x 15 Ametal, Poder x 15 Natural, Poder x 15 Poderal
- Nivel 27: Poder Mental x 7
- Nivel 29: Flora
- Nivel 30: Argnathor Natural, Hombre Angel, Poder x 15 Mayor
- Nivel 34: Acrum x 3, Ardala
- Nivel 35: Sanal, Argnathor Domic, Elfo Brujo
- Nivel 36: Poder Mental x 9
- Nivel 39: Hijo de Keathan
- Nivel 40: Bestia del Caos
- Nivel 43: Angrath
- Nivel 45: Gigante, Acrum x 4, Insignia Solamnica
- Nivel 48: Pesadilla
- Nivel 49: Tentaculo
- Nivel 50: Keatahn, Poder x 20

## Nivel 1

Se mantiene el balance manual de introducción:
- Elfo Bardo: 20%
- Duende: 20%
- Guerrero Menor: 20%
- Mel: 20%
- Mimit: 15%
- Dophan: 3,5%
- Gorad Menor: 1,5%
- Poder Nv 1: 0% porque es infinito

La tienda muestra las probabilidades exactas del nivel de sobre seleccionado y esas probabilidades proceden del mismo motor del servidor que realiza la tirada.
