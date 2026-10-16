"""Paquete del backend de Spitifo.

A proposito NO importa la capa HTTP (starlette/uvicorn): el motor de busqueda y
descarga tiene que poder usarse embebido, sin arrastrar el server. La app ASGI
se importa explicita y solo cuando hace falta:

    from backend.app.main import app
"""
