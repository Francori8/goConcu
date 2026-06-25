FROM golang:1.23

WORKDIR /app

# Copiar y compilar el backend
COPY go.mod .
COPY *.go .
RUN go build -o backend .

# El binario necesita Go disponible en runtime para compilar código del usuario
# golang:1.23 ya lo incluye, no necesitamos nada más

EXPOSE 8080

CMD ["./backend"]
