from pathlib import Path
import math,struct,zlib,json
p=Path(__file__).resolve().parents[1]
assets=p/'src/assets'
# Six stationary rings in three brightness groups of a six-lobed stippled halo. Coordinates are designed
# in 336px space and rasterized to 256px to fit the simulator's texture budget.
for layer in range(3):
 dots=[]
 for band in range(2):
  ring=layer*2+band
  radius=86+12*ring;count=60+6*ring
  for j in range(count):
   a=2*math.pi*(j+.35*ring)/count-math.pi/2
   lobe=.5+.5*math.cos(6*a)
   r=radius+7*math.cos(6*a)+2*math.sin(3*a+.4)
   # Main stipple plus one smaller companion: six readable, closely spaced rings.
   for k in range(2):
    rr=r+k*3.4
    aa=a+k*.007
    dotrad=(1.5+.5*lobe)*(1 if k==0 else .62)
    alpha=(.96 if k==0 else .48)*(.75+.25*lobe)
    dots.append(((167.5+math.cos(aa)*rr)*256/336,(167.5+math.sin(aa)*rr)*256/336,dotrad*256/336,alpha))
 size=256;rows=[]
 for y in range(size):
  row=bytearray([0])
  for x in range(size):
   coverage=max((max(0,min(1,r+.5-math.hypot(x-cx,y-cy)))*alpha for cx,cy,r,alpha in dots if abs(x-cx)<3 and abs(y-cy)<3),default=0)
   row.extend((0,255,0,round(255*coverage)))
  rows.append(row)
 def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
 (assets/f'dots-{layer}.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b''))
 print('layer',layer,'points',len(dots))
