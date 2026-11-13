package alu.aiplayer.world;

import java.util.UUID;

import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityList;
import net.minecraft.entity.EntityLivingBase;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.monster.IMob;
import net.minecraft.entity.passive.EntityAnimal;
import net.minecraft.entity.passive.EntitySheep;
import net.minecraft.entity.passive.EntityTameable;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;
import alu.aiplayer.util.Nbt;

/** Read-only identity and observations; no entity setters, rewards, or special-purpose actions. */
public final class EntityView {

    private EntityView() {}

    private static final String[] WOOL_COLORS = { "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black" };

    public static UUID uuid(String value) {
        try {
            UUID id = UUID.fromString(value);
            if (!id.toString().equalsIgnoreCase(value)) throw new IllegalArgumentException();
            return id;
        } catch (IllegalArgumentException e) {
            throw RpcException.badRequest("entity uuid must be a full UUID from world.entities");
        }
    }

    /** Never load a chunk to find an entity; runtime integer IDs are not persistent identities. */
    public static Entity find(WorldServer world, UUID uuid) {
        for (Object o : world.loadedEntityList) {
            Entity e = (Entity) o;
            if (!e.isDead && uuid.equals(e.getUniqueID())) return e;
        }
        return null;
    }

    public static JsonObject describe(Entity e) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", e.getUniqueID().toString());
        o.addProperty("entityId", e.getEntityId());
        o.addProperty("dim", e.dimension);
        String type = e instanceof EntityPlayer ? "player" : e instanceof IMob ? "mob" : e instanceof EntityAnimal ? "animal" : e instanceof EntityItem ? "item" : "other";
        o.addProperty("type", type);
        String kind = EntityList.getEntityString(e);
        o.addProperty("kind", kind == null ? (e instanceof EntityPlayer ? "Player" : e.getClass().getName()) : kind);
        o.addProperty("name", e.getCommandSenderName());
        o.add("pos", vector(e.posX, e.posY, e.posZ));
        o.add("motion", vector(e.motionX, e.motionY, e.motionZ));
        o.add("state", state(e));
        if (e instanceof EntityItem) {
            ItemStack s = ((EntityItem) e).getEntityItem();
            if (s != null) o.add("item", Names.describe(s));
        }
        return o;
    }

    /** Unlike block coordinates, entity positions and motion keep their full floating-point precision. */
    private static JsonObject vector(double x, double y, double z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }

    public static JsonObject state(Entity e) {
        JsonObject s = new JsonObject();
        s.addProperty("alive", e.isEntityAlive());
        s.addProperty("burning", e.isBurning());
        s.addProperty("inWater", e.isInWater());
        s.addProperty("onGround", e.onGround);
        s.addProperty("sneaking", e.isSneaking());
        s.addProperty("invisible", e.isInvisible());
        if (e.ridingEntity != null) s.addProperty("riding", e.ridingEntity.getUniqueID().toString());
        if (e.riddenByEntity != null) s.addProperty("rider", e.riddenByEntity.getUniqueID().toString());
        if (e instanceof EntityLivingBase) {
            EntityLivingBase living = (EntityLivingBase) e;
            s.addProperty("health", J.round(living.getHealth()));
            s.addProperty("maxHealth", J.round(living.getMaxHealth()));
            s.addProperty("child", living.isChild());
        }
        if (e instanceof EntityAnimal) s.addProperty("inLove", ((EntityAnimal) e).isInLove());
        if (e instanceof EntityTameable) {
            EntityTameable tame = (EntityTameable) e;
            s.addProperty("tamed", tame.isTamed());
            s.addProperty("sitting", tame.isSitting());
            if (tame.isTamed()) s.addProperty("ownerUuid", tame.func_152113_b());
        }
        if (e instanceof EntitySheep) {
            EntitySheep sheep = (EntitySheep) e;
            s.addProperty("sheared", sheep.getSheared());
            s.addProperty("woolMeta", sheep.getFleeceColor());
            s.addProperty("woolColor", WOOL_COLORS[sheep.getFleeceColor() & 15]);
        }
        return s;
    }

    public static JsonObject detail(Entity e, boolean detail, String path) {
        JsonObject o = describe(e);
        if (!detail && path == null) return o;
        // Player save data includes private inventories and mod-specific server data; do not expose it here.
        if (e instanceof EntityPlayer) {
            o.addProperty("savedUnavailable", "player private saved data is not exposed; public observations are above");
            return o;
        }
        try {
            NBTTagCompound tag = new NBTTagCompound();
            e.writeToNBT(tag);
            net.minecraft.nbt.NBTBase part = Nbt.at(tag, path);
            if (part == null) {
                o.addProperty("pathNotFound", true);
                part = tag;
            }
            Nbt.Limits limits = new Nbt.Limits();
            if (path != null) {
                limits.depth = 12;
                limits.list = 200;
                limits.chars = 60000;
            }
            o.add("saved", Nbt.json(part, limits));
            if (limits.cut) o.addProperty("savedCut", true);
        } catch (Throwable t) {
            o.addProperty("savedError", String.valueOf(t));
        }
        return o;
    }
}
