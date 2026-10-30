# OBJETIVO
El objetivo es un viewer que arranque lo más rápido posible, para que la fricción de abrir un archivo markdown sea 0.

# COSAS DEL REPO
Tenemos ci que hace build en los 3 SO, para saltarla mete `[skip ci]` al final del commit.
Solamente salta la ci para pr que no cambien código de la aplicación (como prs de documentación o solamente de pruebas)
Nada de push a main, todo se hace por pr.
